/**
 * Dialog endpoints — `GET /api/events` (SSE), `POST /api/turn`,
 * `POST /api/cancel`, `POST /api/clear`.
 *
 * W513 session-scoped behaviour:
 *   - `/api/turn` targets `{session}` (default = active session) and NEVER 409s
 *     because of a busy session: a running turn takes the input as an
 *     interjection injected at its next step boundary, and the response says so
 *     (`{ok:true, injected:true, turn}`). A 409 survives only for the atomic
 *     re-check race, and only for the target session;
 *   - `/api/cancel` and `/api/clear` take the same optional `{session}`;
 *   - `/api/events` streams every session by default (the envelope carries
 *     `session`), and `?session=<id>` (repeatable) narrows the server side.
 *
 * `/api/turn` returns immediately; everything else travels over SSE. The SSE
 * stream never closes on overflow: a slow subscriber gets ONE `status:lagged`
 * frame (with the session and the dropped count) and keeps consuming.
 */

import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { TurnBusyError } from "@celestea/runtime";
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_DIRNAME, createAttachmentStore, idle, TIMED_OUT } from "@celestea/tools";
import type { ImageRef } from "@celestea/core";
import { CapacityError, type TurnDeliveryMode } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import { questionNonce, questionNonceCookie, secureCookieFor } from "../store/question-nonce.js";
import type { StoreResult } from "../store/result.js";
import { activeSession, capacityJson, DEFAULT_JSON_BODY_BYTES, errorOnly, failJson, readJsonBody, storeFail, strField, type Deps } from "./common.js";

/**
 * B7-2 (audit round 3): the idle-stream heartbeat interval.
 *
 * `contracts/sse-events.json` declares `transport.keepAlive: true` and
 * `contracts/endpoints.json`'s `get_events` notes repeat "KeepAlive
 * enabled" — but nothing implemented it. The read loop below used to await
 * `sub.next()`, and a bus with no traffic leaves that promise unsettled
 * forever, so an idle connection wrote ZERO bytes: measured 0 bytes over a
 * 10s idle window. Every proxy and load balancer in front of a public
 * deployment then reaps the connection on its own idle timeout, and the
 * client sees the event stream die silently — no error, no reconnect, the UI
 * simply stops updating. That is the exact failure `keepAlive` exists to
 * prevent, and the contract had been claiming otherwise the whole time.
 *
 * 25s sits under the 30-60s idle window that nginx (the documented front, see
 * handlers/auth.ts) and cloud load balancers actually use, so the connection
 * is always the thing that speaks first.
 */
export const SSE_KEEPALIVE_MS = 25_000;

/**
 * The bytes of one heartbeat.
 *
 * A **comment frame** (a line starting with `:`), by deliberate choice over
 * the two alternatives:
 *
 *   · it is a no-op for the client. Per the SSE spec a comment line is
 *     ignored entirely, and `apps/web/src/sse.ts` dispatches with
 *     `es.addEventListener(name, ...)` for the ten frozen event names — an
 *     event-less frame therefore reaches **no** handler, so a heartbeat can
 *     never be mistaken for a turn, a status or a lagged marker;
 *   · it does not touch the contract. `tools/check-sse-events.mjs` compares
 *     the event-name SET across contracts/sse-events.json, core's
 *     `SSE_EVENT_NAMES` and the frontend's `EVENT_NAMES`; a frame with no
 *     `event:` field adds no name to any of the three, so `contracts/**`
 *     stays byte-identical;
 *   · it does not consume a `seq`. The P5 replay harness compares the frame
 *     stream byte-for-byte, so spending a sequence number on a synthetic
 *     frame would make replay non-deterministic.
 *
 * Hono's `SSEMessage` requires a `data` field and so cannot express a
 * comment; `SSEStreamingApi` extends `StreamingApi`, whose `write()` is the
 * same primitive `writeSSE` itself calls, so one raw line is written here.
 */
const SSE_KEEPALIVE_FRAME = ": keepalive\n\n";

/**
 * The next real frame, [TIMED_OUT] when the stream went quiet for a full
 * interval, or null when the subscription is closed.
 *
 * W2014: this is the sanctioned [idle] primitive from `@celestea/tools`, not a
 * hand-rolled race. That primitive is the repo's single deadline
 * implementation (`packages/tools/src/sandbox/async.ts`), and its module
 * header names this exact shape as one of the call sites that motivated it:
 * captureSseWire hands every reader.read() the SAME 300 ms and gives up only
 * when the stream itself goes quiet. Each `sub.next()` here is one demand
 * against the IDLE clock, so [idle] is the honest name for it.
 *
 * Two properties come from the primitive and were worth the hand-rolled version
 * I first wrote: the timer is cleared in a `finally` (a busy stream produces
 * thousands of frames, and one leaked 25s timer per frame would be thousands of
 * live handles), and a rejection that lands AFTER the idle deadline already won
 * is swallowed instead of surfacing as an unhandled rejection.
 *
 * The [TIMED_OUT] sentinel is also what keeps this call site honest: a busy
 * stream must be able to tell a quiet stream (heartbeat) from a CLOSED
 * subscription (break) — two different loop exits that a single `null`
 * conflates, and conflating them hangs the loop forever.
 */
export async function nextFrameOrKeepalive<T>(
  sub: { next(): Promise<T | null> },
  keepAliveMs: number = SSE_KEEPALIVE_MS,
): Promise<T | null | typeof TIMED_OUT> {
  return idle(sub.next(), keepAliveMs);
}
/**
 * B7-2: the keepalive interval is a parameter, not a constant baked into the
 * loop, so the end-to-end test can drive a real handler on a millisecond
 * interval instead of waiting 25s (or fighting vitest's fake clock against a
 * TransformStream — the two do not mix: the timer fires but the reader never
 * settles, which is exactly the deadlock the first draft of the test hit).
 */
export interface DialogOptions {
  keepAliveMs?: number;
}

function registerEvents(app: Hono, deps: Deps, table: RouteTable, keepAliveMs: number): string {
  const events = table.get("get_events");
  app.on(events.method, events.honoPath, (c) => {
    const asked = c.req.queries("session") ?? [];
    const response = streamSSE(c, async (stream) => {
      const sub = deps.bus.subscribe(asked.length === 0 ? {} : { sessions: asked });
      stream.onAbort(() => sub.close());
      try {
        for (;;) {
          // A heartbeat makes a dead stream reachable in a way the old
          // never-settling await did not: without this guard the loop keeps
          // waking and calling write() on a stream the client has already
          // cancelled, which hangs the write forever and leaks the loop (the
          // test suite would not exit). `aborted` is Hono's own signal that
          // the readable side is gone.
          if (stream.aborted) break;
          // B7-2: give the next frame ONE idle budget. A real frame wins and
          // resets the clock, so a busy stream heartbeats only when it has
          // genuinely been quiet for a full interval (no extra bytes on a live
          // connection); an expired budget only writes the comment frame.
          const frame = await nextFrameOrKeepalive(sub, keepAliveMs);
          // Two exits, now distinguishable only because the deadline resolves
          // the TIMED_OUT sentinel instead of a null that the bus also uses.
          if (frame === TIMED_OUT) {
            await stream.write(SSE_KEEPALIVE_FRAME);
            continue;
          }
          // null = the subscription closed (the pre-keepalive `break`). Losing
          // this arm is what conflating the two would cost: the loop would
          // heartbeat forever on a dead subscription.
          if (frame === null) break;
          await stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.envelope) });
        }
      } finally {
        sub.close();
      }
    });
    response.headers.set("cache-control", "no-cache");
    // M2: the browser picks up the answer nonce here as well, and this is the
    // RACE-FREE half: a `question` frame travels ON this very stream, so its
    // response headers (and therefore the cookie) are already processed before
    // any card can be rendered — let alone answered. `response` is the pre-built
    // SSE Response, so the header goes on it directly (see B7-04: middleware
    // headers do not reach this one).
    response.headers.append(
      "set-cookie",
      questionNonceCookie(questionNonce(), secureCookieFor(c.req.header("x-forwarded-proto"))),
    );
    return response;
  });
  return events.id;
}

/** W866: the engine-memory worker session prefix (`worker:<sid>`). */
const WORKER_SESSION_PREFIX = "worker:";

/**
 * W866: the inner session id of an engine-memory worker target, else null.
 *
 * A worker conversation lives in its owner session's `WorkerRegistry`, not on
 * disk: `sessions.require("worker:…")` can only 404 it. Recognising the prefix
 * HERE is what lets a USER message take the worker route instead of the
 * filesystem-session route (parity with the DSH-side `worker:<sid>` ids the UI
 * already lists and renders).
 */
function workerSidOf(asked: string | undefined): string | null {
  if (typeof asked !== "string" || !asked.startsWith(WORKER_SESSION_PREFIX)) return null;
  const sid = asked.slice(WORKER_SESSION_PREFIX.length);
  return sid === "" ? null : sid;
}

/**
 * W866: deliver one USER message to an engine-memory worker session.
 *
 * The delivery itself is the SAME `send_message` tool the model calls (the
 * worker driver serialises mailbox arrivals into its own turns), so the user
 * path and the model path cannot drift. Two deliberate refusals before that:
 * images (the mailbox carries text only) and unknown/settled workers (a message
 * queued for a worker nobody drives would report success and never be processed).
 */
async function workerTurn(
  c: Parameters<typeof failJson>[0],
  deps: Deps,
  sid: string,
  text: string,
  rawAttachments: unknown,
): Promise<Response> {
  if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
    return failJson(c, 400, "worker sessions accept text only");
  }
  if (text === "") return errorOnly(c, 400, "input must not be empty");
  const id = WORKER_SESSION_PREFIX + sid;
  const row = deps.runtime.workerSessions().find((w) => w.id === id);
  if (row === undefined) return failJson(c, 404, `unknown session '${id}'`);
  const out = await deps.runtime.workerSend({ target: sid, content: text });
  if (out["ok"] !== true) {
    return failJson(c, 404, String(out["error"] ?? `unknown session '${id}'`));
  }
  // `status`/`state` let the client say whether the worker is still RUNNING
  // (idle/in-turn) or settled — the one fact the delivery envelope does not carry.
  return c.json({
    ok: true,
    delivered: true,
    injected: false,
    pending: 0,
    placement: "context",
    worker: sid,
    status: row.status ?? "",
    state: row.state ?? "",
  });
}

/** The turn target: an explicit `{session}`, else the active session. */
function turnTarget(c: Parameters<typeof failJson>[0], deps: Deps, asked: string | undefined): StoreResult<string | null> {
  if (asked === undefined || asked === "") return { ok: true, value: activeSession(deps) };
  const required = deps.sessions.require(asked);
  if (!required.ok) return required;
  return { ok: true, value: required.value.id };
}

/** W804: the inline attachments one POST /api/turn may carry (section 7.4 P0). */
const MAX_TURN_ATTACHMENTS = 20;

/**
 * Decode the optional inline base64 `attachments` and store them under
 * `<session-dir>/attachments/`. P0 adds NO upload endpoint: the bytes ride the
 * turn body and the session log only ever sees the returned references.
 */
async function storeTurnAttachments(
  c: Parameters<typeof failJson>[0],
  deps: Deps,
  session: string | null,
  raw: unknown,
): Promise<{ ok: true; refs: ImageRef[] } | { ok: false; response: Response }> {
  if (raw === undefined || raw === null) return { ok: true, refs: [] };
  if (!Array.isArray(raw)) return { ok: false, response: errorOnly(c, 400, "attachments must be an array") };
  if (raw.length === 0) return { ok: true, refs: [] };
  if (raw.length > MAX_TURN_ATTACHMENTS) {
    return { ok: false, response: errorOnly(c, 400, `too many attachments (max ${MAX_TURN_ATTACHMENTS})`) };
  }
  const resolved = session === null ? null : deps.sessions.resolve(session);
  const dir = resolved !== null && resolved.ok ? resolved.value.dir : null;
  if (dir === null) return { ok: false, response: errorOnly(c, 400, "attachments require a resolvable session directory") };
  const store = createAttachmentStore(join(dir, ATTACHMENTS_DIRNAME));
  const refs: ImageRef[] = [];
  for (const item of raw) {
    const rec = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const data = rec["data"];
    const name = typeof rec["name"] === "string" ? rec["name"] : undefined;
    if (typeof data !== "string" || data.trim() === "") {
      return { ok: false, response: errorOnly(c, 400, "each attachment needs a non-empty base64 data string") };
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0) return { ok: false, response: errorOnly(c, 400, "attachment data decoded to zero bytes") };
    try {
      refs.push(await store.put({ bytes, ...(name === undefined ? {} : { name }) }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, response: errorOnly(c, 400, `attachment rejected: ${message}`) };
    }
  }
  return { ok: true, refs };
}

function registerTurn(app: Hono, deps: Deps, table: RouteTable): string {
  const turn = table.get("post_turn");
  app.on(turn.method, turn.honoPath, async (c) => {
    // W9230 (W9206-38): this is the ONE route that legitimately exceeds the default
    // JSON ceiling — it carries up to MAX_TURN_ATTACHMENTS inline base64 images
    // (each capped at ATTACHMENT_MAX_BYTES AFTER decoding, so base64 inflates them
    // by 4/3). The budget is derived from those two constants rather than typed as
    // a number, so it cannot drift when either cap moves; `+ 1 MiB` leaves room for
    // the text, the JSON envelope and the per-item `name`.
    const read = await readJsonBody(c, true, MAX_TURN_ATTACHMENTS * ATTACHMENT_MAX_BYTES * 2 + DEFAULT_JSON_BODY_BYTES);
    if (!read.ok) return read.response;
    const input = strField(c, read.body, "input");
    const asked = strField(c, read.body, "session");
    for (const field of [input, asked]) if (!field.ok) return field.response;
    // W847: resolve + validate the delivery lane BEFORE anything is written, so
    // an illegal mode never leaves an attachment (or a stored turn) behind. An
    // omitted mode is "steer" — byte-identical to the pre-W847 request.
    const requestedMode = read.body["mode"];
    if (requestedMode !== undefined && requestedMode !== null && requestedMode !== "steer" && requestedMode !== "queue") {
      return failJson(c, 400, 'invalid mode: ' + String(requestedMode) + ' (expected "steer" or "queue")');
    }
    const mode: TurnDeliveryMode = requestedMode === "queue" ? "queue" : "steer";
    const text = (input.ok ? (input.value ?? "") : "").trim();
    // W866: an engine-memory worker session (`worker:<sid>`) is NOT a filesystem
    // session — `turnTarget` could only 404 it, and `startTurn`/`inject` would
    // compose a ghost runtime for the id (the W833 bug). A user message to a
    // worker takes the worker route before any of that.
    const workerSid = workerSidOf(asked.ok ? asked.value : undefined);
    if (workerSid !== null) return workerTurn(c, deps, workerSid, text, read.body["attachments"]);
    const target = turnTarget(c, deps, asked.ok ? asked.value : undefined);
    if (!target.ok) return storeFail(c, target);
    const session = target.value;
    // W804: decode + store the optional inline image attachments BEFORE the
    // empty-input check — a turn may legitimately carry images and no text.
    // W815-4: a busy session REFUSES image attachments (steering lanes carry
    // text only), so refuse BEFORE `storeTurnAttachments` writes anything under
    // <session>/attachments/ — the old order wrote up to 20 * 4 MiB and only then
    // 409'd, leaking every byte for a turn that was never started.
    const rawAttachments = read.body["attachments"];
    if (deps.runtime.isBusy(session) && Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      return busyAttachmentError(c);
    }
    const stored = await storeTurnAttachments(c, deps, session, rawAttachments);
    if (!stored.ok) return stored.response;
    const attachments = stored.refs;
    if (text === "" && attachments.length === 0) return errorOnly(c, 400, "input must not be empty");
    if (deps.runtime.isBusy(session)) {
      // W513 steering lanes carry TEXT only: an image must never be silently
      // dropped, so a busy session refuses rather than pretends.
      if (attachments.length > 0) return busyAttachmentError(c);
      return injectInto(c, deps, text, session, mode);
    }
    try {
      const started = await deps.runtime.startTurn({
        input: text,
        session,
        ...(attachments.length === 0 ? {} : { attachments }),
      });
      // W515 §2: the turn's own input IS the context the model sees first.
      return c.json({ turn: started.turn, status: "started", placement: started.placement ?? "context" }, 202);
    } catch (e) {
      if (e instanceof TurnBusyError) {
        if (attachments.length > 0) return busyAttachmentError(c);
        return injectInto(c, deps, text, session, mode);
      }
      if (e instanceof CapacityError) return capacityJson(c, e);
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
  });
  return turn.id;
}

/** W804: the running-turn refusal (steering cannot carry an image). */
function busyAttachmentError(c: Parameters<typeof failJson>[0]): Response {
  return failJson(c, 409, "attachments cannot be injected into a running turn; send them when the turn finishes");
}


/**
 * W513/W847: the session is busy -> the input joins a lane. `mode` = "steer"
 * injects into the RUNNING turn at its next step boundary; "queue" parks it for
 * the next turn start. The response shape is unchanged (the caller reads
 * `placement`, not `injected`, to render the terminal state).
 */
function injectInto(c: Parameters<typeof failJson>[0], deps: Deps, text: string, session: string | null, mode: TurnDeliveryMode): Response {
  const out = deps.runtime.inject({ input: text, session, mode });
  return c.json({ ok: true, injected: out.injected, turn: out.turn, pending: out.pending, placement: out.placement, duplicate: out.duplicate });
}

/** The optional `{session}` of the cancel/clear bodies (absent = active). */
type SessionBody = { ok: true; session: string | null } | { ok: false; response: Response };

async function bodySession(c: Parameters<typeof failJson>[0], deps: Deps): Promise<SessionBody> {
  const read = await readJsonBody(c, false);
  if (!read.ok) return { ok: false, response: read.response };
  const asked = strField(c, read.body, "session");
  if (!asked.ok) return { ok: false, response: asked.response };
  const target = turnTarget(c, deps, asked.value);
  if (!target.ok) return { ok: false, response: storeFail(c, target) };
  return { ok: true, session: target.value };
}

function registerCancel(app: Hono, deps: Deps, table: RouteTable): string {
  const cancel = table.get("post_cancel");
  app.on(cancel.method, cancel.honoPath, async (c) => {
    const target = await bodySession(c, deps);
    if (!target.ok) return target.response;
    return c.json({ ok: true, cancelled: deps.runtime.cancel(target.session) });
  });
  return cancel.id;
}

function registerClear(app: Hono, deps: Deps, table: RouteTable): string {
  const clear = table.get("post_clear");
  app.on(clear.method, clear.honoPath, async (c) => {
    const target = await bodySession(c, deps);
    if (!target.ok) return target.response;
    const session = target.session;
    try {
      await deps.runtime.clear(session);
    } catch (e) {
      if (e instanceof TurnBusyError) return failJson(c, 409, "a turn is already running");
      return failJson(c, 500, e instanceof Error ? e.message : String(e));
    }
    if (session !== null) {
      const resolved = deps.sessions.resolve(session);
      if (resolved.ok) deps.sessions.truncate(resolved.value);
    }
    return c.json({ ok: true, cleared: true, session });
  });
  return clear.id;
}

export function registerDialog(
  app: Hono,
  deps: Deps,
  table: RouteTable,
  opts: DialogOptions = {},
): string[] {
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  return [
    registerEvents(app, deps, table, keepAliveMs),
    registerTurn(app, deps, table),
    registerCancel(app, deps, table),
    registerClear(app, deps, table),
  ];
}
