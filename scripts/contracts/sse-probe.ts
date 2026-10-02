/**
 * EX-03 —— §3 SSE 传输探针。
 *
 * 纯搬家：判定与文案逐字保留；sse.events.length 由调用方传入（契约在 main 里已加载）。
 */
import { probeHeaders } from "../lib/http.js";
import { fail, pass } from "./checks.js";
import { STUDIO, TIMEOUT } from "./runtime.js";

export async function runSseProbe(eventCount: number): Promise<void> {
  const sseProbe = await probeHeaders(STUDIO, "/api/events", Math.min(TIMEOUT, 4000));
  const ct = sseProbe.headers["content-type"] ?? "";
  if (ct.includes("text/event-stream")) {
    pass("GET /api/events", "sse-transport", `content-type=${ct}; envelope + ${eventCount} event names frozen from source (passive connect, no turn running)`, sseProbe.status);
  } else {
    fail("GET /api/events", "sse-transport", `content-type=${ct || "(none)"}`, sseProbe.status);
  }
}
