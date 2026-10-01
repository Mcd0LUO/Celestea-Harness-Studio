/**
 * Phase 2 · the compression DECORATOR — a `SessionLog` whose DERIVED VIEW
 * carries the compression overlay.
 *
 * Exactly the discipline of `checkpointedLog` (checkpoint-log.ts), for the
 * same reason: the seam the model reads is `deriveMessages()`, and the only
 * place guaranteed to see it is the log object itself. So the overlay is a
 * transparent Proxy — `append` / `events` / `clear` are the INNER log's,
 * untouched, and only `deriveMessages` is overlaid. The append-only log never
 * learns that compression happened.
 *
 * Layering matters: this decorator is applied ON TOP of the checkpoint log, so
 * a compression's view change is visible to the loop, to the dedup's
 * visibility simulation and to the context viewer, while checkpoint bookkeeping
 * keeps seeing the raw rows.
 *
 * `clear()` additionally drops the blocks, because an emptied log has no turns
 * left for them to stand in for: keeping them would render summaries of turns
 * that no longer exist.
 */

import { overlayCompressions } from "@celestea/core";
import type { Message, SessionEvent, SessionLog } from "@celestea/core";
import type { CompressionStore } from "./compression.js";

/** Access key of the wrapped store (symbol: invisible to JSON / spread). */
export const COMPRESSION_STORE = Symbol.for("celestea.session.compressionStore");

/** Wrap `log` so `deriveMessages()` projects the overlay over [store]. */
export function compressedLog(log: SessionLog, store: CompressionStore): SessionLog {
  const handler: ProxyHandler<SessionLog> = {
    get(target, prop) {
      if (prop === COMPRESSION_STORE) return store;
      if (prop === "deriveMessages") return (): Message[] => overlayCompressions(target.events(), store.blocks());
      if (prop === "clear") {
        return (): void => {
          target.clear();
          store.save([]);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  };
  return new Proxy(log, handler);
}

/**
 * The store behind a decorated log (null for a plain log, e.g. an embedding
 * that never mounted Phase 2). Callers treat null as "compression is off" and
 * leave the view alone.
 */
export function compressionStoreOf(log: SessionLog | null | undefined): CompressionStore | null {
  if (log === null || log === undefined) return null;
  const store = (log as { [COMPRESSION_STORE]?: unknown })[COMPRESSION_STORE];
  if (store === null || store === undefined) return null;
  const view = store as CompressionStore;
  return typeof view.blocks === "function" && typeof view.save === "function" ? view : null;
}

/** The overlay's mutation counter, or 0 when the log carries no overlay. */
export function compressionVersionOf(log: SessionLog | null | undefined): number {
  return compressionStoreOf(log)?.version() ?? 0;
}

/**
 * Append a row and keep the overlay honest about it.
 *
 * Used by tests and by any embedding that appends through a reference obtained
 * BEFORE the decoration: forwarding `append` this way keeps the two paths
 * identical. (The Proxy's own `append` is the inner log's, so a normal turn
 * needs no special handling — the overlay reads the store on every projection.)
 */
export function appendThroughOverlay(log: SessionLog, event: SessionEvent): void {
  log.append(event);
}
