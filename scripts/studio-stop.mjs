#!/usr/bin/env node
/**
 * Stop the Studio process that is holding the port.
 *
 * WHY this exists (docs/AGENT.md §6): `pnpm --dir apps/studio start` is a
 * TWO-level parent chain — pnpm -> tsx(node) -> node — so the process that HOLDS
 * the port is a GRANDCHILD of the one you started. A signal (or a job-kill) aimed
 * at the wrapper is not guaranteed to reach it, and when it does not, the port
 * stays bound and /api/health keeps answering 200 while `main.ts`'s SIGTERM
 * teardown never runs.
 *
 * Evidence, stated exactly: W9261 measured one such survivor (a node child still
 * listening after its pnpm job was killed); the main session then tried twice to
 * reproduce it and could not — both times the child died with the wrapper. So the
 * LEVER is real and the failure is intermittent/platform-dependent; this script
 * does not depend on which: it stops whatever holds the PORT, which is the thing
 * that actually matters.
 *
 * Usage:
 *   node scripts/studio-stop.mjs [--port 3777]
 *   pnpm run stop
 *
 * Exit codes: 0 = nothing was listening, or it is gone now; 1 = it is still there.
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const at = argv.indexOf("--port");
const raw = at >= 0 ? argv[at + 1] : (process.env["CELESTEA_STUDIO_PORT"] ?? process.env["STUDIO_TS_PORT"] ?? "3777");
const port = Number(raw);
if (!Number.isInteger(port) || port <= 0) {
  console.error(`studio-stop: bad port ${String(raw)}`);
  process.exit(1);
}

const WINDOWS = process.platform === "win32";

/** Pids LISTENING on `port` right now (empty when none, or when the probe is unavailable). */
function listeners() {
  try {
    if (WINDOWS) {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      return [...new Set(
        out
          .split("\n")
          .filter((line) => line.includes(`:${port} `) && /LISTENING/i.test(line))
          .map((line) => line.trim().split(/\s+/).pop() ?? "")
          .filter((pid) => /^\d+$/.test(pid)),
      )];
    }
    // POSIX: lsof, then ss, then nothing (a missing probe must not look like success).
    for (const probe of [`lsof -ti tcp:${port} -sTCP:LISTEN`, `ss -ltnp 2>/dev/null | grep ':${port} '`]) {
      try {
        const out = execFileSync("sh", ["-c", probe], { encoding: "utf8" });
        const pids = [...out.matchAll(/(?:pid=|\s)(\d+)(?:,|\s|$)/g)].map((m) => m[1] ?? "");
        if (pids.length > 0) return [...new Set(pids.filter((p) => /^\d+$/.test(p)))];
      } catch {
        // try the next probe
      }
    }
    return [];
  } catch {
    return [];
  }
}

const before = listeners();
if (before.length === 0) {
  console.log(`studio-stop: nothing is listening on ${port}`);
  process.exit(0);
}

let failed = false;
for (const pid of before) {
  try {
    if (WINDOWS) {
      // /T kills the whole tree: that is the whole point (the listener is a GRANDCHILD of pnpm).
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
    console.log(`studio-stop: signalled ${pid} (port ${port})`);
  } catch (error) {
    failed = true;
    console.error(`studio-stop: could not stop ${pid}: ${String(error)}`);
  }
}

// Re-probe: a wrapper that came back, or a pid we could not touch, must not read as success.
await new Promise((resolve) => setTimeout(resolve, 500));
const after = listeners();
if (after.length > 0) {
  console.error(`studio-stop: port ${port} is STILL held by ${after.join(", ")}`);
  process.exit(1);
}
console.log(`studio-stop: port ${port} is free`);
process.exit(failed ? 1 : 0);
