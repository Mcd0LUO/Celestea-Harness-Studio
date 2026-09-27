/**
 * Worker orchestration — `src/api.rs:437-503`.
 *
 * The three endpoints proxy the engine's worker tools so the HTTP surface and
 * the agent tool surface cannot drift. A tool-level refusal (`{ok:false,…}`) is
 * still HTTP 200; only a HARD dispatch failure is 502, and a tool that returns
 * no value at all is 500.
 */

import type { Context, Hono } from "hono";
import type { RouteTable } from "../routes.js";
import type { RuntimeAdapter } from "../runtime-adapter.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

function registerSpawn(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_worker_spawn");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const wid = strField(c, read.body, "wid");
    const brief = strField(c, read.body, "brief");
    const title = strField(c, read.body, "title");
    const model = strField(c, read.body, "model");
    const reportTo = strField(c, read.body, "report_to");
    const session = strField(c, read.body, "session");
    for (const f of [wid, brief, title, model, reportTo, session]) if (!f.ok) return f.response;
    if ((wid.ok ? wid.value : undefined) === undefined || (brief.ok ? brief.value : undefined) === undefined) {
      return failJson(c, 422, "fields 'wid' and 'brief' are required");
    }
    // W833 (R3 B7 / W816 F3): an explicit session must RESOLVE before a worker
    // is composed against it. Passing an unknown id used to compose an in-memory
    // ghost instance (live slot + autowake loop + worker row) whose receipt no
    // one could ever receive. Omitted/empty session keeps the detached default.
    if (session.ok && typeof session.value === "string" && session.value !== "") {
      const resolved = deps.sessions.require(session.value);
      if (!resolved.ok) return storeFail(c, resolved);
    }
    return spawnResponse(c, deps, {
      wid: wid.ok ? (wid.value as string) : "",
      brief: brief.ok ? (brief.value as string) : "",
      title: title.ok ? title.value : undefined,
      model: model.ok ? model.value : undefined,
      report_to: reportTo.ok ? reportTo.value : undefined,
      session: session.ok ? (session.value ?? null) : null,
    });
  });
  return route.id;
}

/**
 * W9230 (W9206-41): dispatch `workerSpawn` with a structured answer on EVERY path.
 *
 * The engine seam reaches the fleet RPC and can THROW; without this catch the
 * throw escaped to Hono's default `onError`, which answers
 * `text/plain "Internal Server Error"` — violating the frozen `{ok:false,error}`
 * convention every other handler keeps (and the client cannot parse it).
 */
async function spawnResponse(c: Context, deps: Deps, req: Parameters<RuntimeAdapter["workerSpawn"]>[0]): Promise<Response> {
  let out: Awaited<ReturnType<RuntimeAdapter["workerSpawn"]>>;
  try {
    out = await deps.runtime.workerSpawn(req);
  } catch (e) {
    return failJson(c, 502, `worker spawn failed: ${errText(e)}`);
  }
  if (out.ok) return c.json({ ok: true, sessionId: out.sessionId, title: out.title, wid: out.wid });
  if (out.error === undefined && out.value === undefined) return failJson(c, 500, "tool returned no value");
  return failJson(c, 502, out.error ?? "worker spawn failed", out.value === undefined ? undefined : { value: out.value });
}

function registerSend(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_worker_send");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const target = strField(c, read.body, "target");
    const content = strField(c, read.body, "content");
    for (const f of [target, content]) if (!f.ok) return f.response;
    if ((target.ok ? target.value : undefined) === undefined || (content.ok ? content.value : undefined) === undefined) {
      return failJson(c, 422, "fields 'target' and 'content' are required");
    }
    const out = await deps.runtime.workerSend({ target: target.ok ? (target.value as string) : "", content: content.ok ? (content.value as string) : "" });
    return c.json(out);
  });
  return route.id;
}

function registerStatus(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_worker_status");
  app.on(route.method, route.honoPath, (c) => {
    const wid = c.req.query("wid");
    return c.json(deps.runtime.workerStatus(wid === undefined || wid === "" ? undefined : wid));
  });
  return route.id;
}

export function registerWorker(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerSpawn(app, deps, table), registerSend(app, deps, table), registerStatus(app, deps, table)];
}
