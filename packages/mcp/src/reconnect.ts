/**
 * The reconnect budget (docs/feature/mcp-client.md §6.2).
 *
 * Split out of connection.ts on purpose: the budget is a POLICY with its own
 * rules, and rules that live next to the plumbing stop being reviewed as rules.
 *
 *   - delay(n) = min(maxDelay, initial * 2^(n-1)), attempt counted from 1;
 *   - one shared budget per FAILURE STREAK (`maxAttempts`);
 *   - the budget is refreshed only after a connection survived the stability
 *     window (= maxDelay). Without that clause a server that crashes right after
 *     connecting would burn its whole budget in its first minute and then never be
 *     retried again;
 *   - HTTP is never supervised: its transport recovers per request and there is no
 *     child process to relaunch, so retrying would only duplicate work.
 */

import type { Scheduler } from "./scheduler.js";
import type { McpServerConfig, McpReconnectPolicy } from "./types.js";

/** `min(maxDelay, initial * 2^(n-1))`, attempt counted from 1. */
export function backoffDelayMs(policy: McpReconnectPolicy, attempt: number): number {
  const step = Math.max(attempt, 1) - 1;
  return Math.min(policy.maxDelayMs, Math.round(policy.initialDelayMs * Math.pow(2, step)));
}

/** Only stdio is supervised; see the module header for why HTTP is excluded. */
export function isSupervisable(server: McpServerConfig): boolean {
  return server.transport === "stdio" && server.reconnect.enabled;
}

export interface ReconnectSupervisor {
  /** A fresh failure streak begins (the initial connect). */
  begin(): void;
  /** Record that the connection just became ready (starts the stability window). */
  markReady(): void;
  /** Arm the next retry (running `retry` when it fires), or give up. */
  arm(retry: () => void): boolean;
  /** Cancel a pending retry: disposal, or a call-time re-connect took over. */
  cancel(): void;
  /** Is a retry currently armed? */
  isArmed(): boolean;
}

export function createReconnectSupervisor(
  server: McpServerConfig,
  scheduler: Scheduler,
  now: () => number,
): ReconnectSupervisor {
  const policy = server.reconnect;
  let attempts = 0;
  let lastReadyAt: number | null = null;
  let cancelPending: (() => void) | null = null;

  /** A connection that stayed up past the stability window earns a fresh budget. */
  function refreshBudgetIfStable(): void {
    if (lastReadyAt !== null && now() - lastReadyAt >= policy.maxDelayMs) attempts = 0;
  }

  return {
    begin(): void {
      attempts = 1;
    },
    markReady(): void {
      lastReadyAt = now();
    },
    arm(retry: () => void): boolean {
      refreshBudgetIfStable();
      if (!isSupervisable(server) || attempts >= policy.maxAttempts) return false;
      const delay = backoffDelayMs(policy, attempts);
      cancelPending = scheduler.schedule(() => {
        cancelPending = null;
        attempts++;
        retry();
      }, delay);
      return true;
    },
    cancel(): void {
      cancelPending?.();
      cancelPending = null;
    },
    isArmed(): boolean {
      return cancelPending !== null;
    },
  };
}
