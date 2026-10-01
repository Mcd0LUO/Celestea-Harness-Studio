/**
 * Provider endpoints — `src/providers.rs:673-797`.
 *
 * Every response is a `public_view`: the `api_key` KEY does not exist in the
 * shape at all. `/api/providers/test` accepts a full inline overlay that is
 * never persisted; `/models/fetch` resolves the row from the store and may
 * borrow the engine's own key for a same-origin keyless provider.
 */

import type { Hono } from "hono";
import { EngineError } from "../runtime-adapter.js";
import type { RouteTable } from "../routes.js";
import { probeModels, testProvider, type ProbeCandidate, type ProbeOptions } from "../store/provider-probe.js";
import { REQUEST_FORMATS, type ProviderRow, type RequestFormat } from "../store/providers.js";
import { isHttpUrl } from "../store/validate.js";
import { baseUrlOf } from "./config-shape.js";
// W742 §1: the same "background work in flight" guard `POST /api/config` uses.
import { workersInFlight } from "./config.js";
import { failJson, readJsonBody, strField, storeFail, type Deps, type JsonObject } from "./common.js";

function probeOptions(deps: Deps): ProbeOptions {
  return { engineBaseUrl: baseUrlOf(deps), engineKey: process.env[deps.config.apiKeyEnv] ?? null };
}

/** Validate a candidate the way the retired backend validated `ProviderReq` before probing. */
function candidateError(candidate: ProbeCandidate): string | null {
  if (candidate.base_url.trim() === "") return "base_url is required";
  if (!isHttpUrl(candidate.base_url)) return "base_url must be an http:// or https:// URL";
  if (!(REQUEST_FORMATS as readonly string[]).includes(candidate.request_format)) {
    return `invalid request_format '${candidate.request_format}': expected chat_completions | responses | anthropic_messages`;
  }
  return null;
}

function asCandidate(body: JsonObject, stored: ProviderRow | undefined): ProbeCandidate {
  const fmt = typeof body["request_format"] === "string" ? (body["request_format"] as RequestFormat) : (stored?.request_format ?? "chat_completions");
  return {
    id: stored?.id ?? "__inline__",
    base_url: typeof body["base_url"] === "string" ? body["base_url"] : (stored?.base_url ?? ""),
    request_format: fmt,
    api_key: typeof body["api_key"] === "string" ? body["api_key"] : (stored?.api_key ?? null),
  };
}

function registerList(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_providers");
  app.on(route.method, route.honoPath, (c) => c.json(deps.providers.response()));
  return route.id;
}

function registerUpsert(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_providers");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const body = read.body;
    const models = body["models"];
    // W815-7: a PRESENT but wrongly-typed `models` is a 400. It used to fall
    // through as `undefined`, which the store reads as "absent" and therefore
    // CLEARS the list — only an absent/null field may clear (docs/pitfalls P1b).
    if (models !== undefined && models !== null && !Array.isArray(models)) return failJson(c, 400, "models must be an array");
    // W9230 (W9206-44): a PRESENT but wrongly-typed `api_key` is a 422, not a silent
    // "keep the stored key" — `api_key` is the ONE keep-on-default field, so coercing a
    // non-string to `null` made `api_key: 123` look accepted while the OLD credential
    // stayed in place (a silent no-op on a secret). Kept on the same line count as the
    // code it replaces: docs/pitfalls.md pins a line anchor into this file.
    const apiKey = strField(c, body, "api_key");
    if (!apiKey.ok) return apiKey.response;
    const res = deps.providers.upsert({
      id: typeof body["id"] === "string" ? body["id"] : undefined,
      name: typeof body["name"] === "string" ? body["name"] : undefined,
      note: typeof body["note"] === "string" ? body["note"] : undefined,
      base_url: typeof body["base_url"] === "string" ? body["base_url"] : undefined,
      request_format: typeof body["request_format"] === "string" ? body["request_format"] : undefined,
      api_key: apiKey.value,
      models: Array.isArray(models) ? (models as Array<Record<string, unknown>>) : undefined,
    });
    if (!res.ok) return storeFail(c, res);
    return c.json(res.value);
  });
  return route.id;
}

function registerDelete(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_delete");
  app.on(route.method, route.honoPath, (c) => {
    const res = deps.providers.remove(c.req.param("id") ?? "");
    if (!res.ok) return storeFail(c, res);
    return c.json({ ok: true });
  });
  return route.id;
}

function registerTest(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_test");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c, false);
    if (!read.ok) return read.response;
    const id = strField(c, read.body, "id");
    if (!id.ok) return id.response;
    const stored = id.value === undefined ? undefined : deps.providers.find(id.value);
    const candidate = asCandidate(read.body, stored);
    const bad = candidateError(candidate);
    if (bad !== null) return failJson(c, 400, bad);
    const out = await testProvider(candidate, probeOptions(deps));
    if (!out.ok) return c.json({ ok: false, error: out.error });
    return c.json({ ok: true, latency_ms: out.latency_ms, model_count: out.model_count });
  });
  return route.id;
}

function registerModelsFetch(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_models_fetch");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    const stored = deps.providers.find(id);
    if (stored === undefined) return failJson(c, 404, `unknown provider '${id}'`);
    const out = await probeModels(
      { id: stored.id, base_url: stored.base_url, request_format: stored.request_format, api_key: stored.api_key },
      probeOptions(deps),
    );
    if (!out.ok) return c.json({ ok: false, error: out.error });
    return c.json({ ok: true, models: out.models });
  });
  return route.id;
}

/**
 * POST /api/providers/default — make (provider, model) the default pair.
 *
 * W750: `provider_id` is the OPTIONAL disambiguator. Model ids are not unique
 * across providers (production: `deepseek-flash` is listed by both the gateway
 * and 「基元」), so "model id only" cannot express "switch to THAT provider" —
 * the plain `find` below would keep picking the first provider that happens to
 * list the id. When `provider_id` is given the model must be one of that
 * provider's models (otherwise nothing is applied: 400/404, no partial write);
 * when it is absent the historical first-lister behaviour is unchanged.
 *
 * W2065: the owner's `base_url` is applied for EVERY request format, not just
 * `chat_completions`. The old condition `owner.request_format === "chat_completions"`
 * made 「switch to a model on another provider」 silently keep the PREVIOUS
 * provider's endpoint for any row declared `responses` or `anthropic_messages`:
 * the model switched, `base_url` did not, and the new model id was posted to the
 * old provider (user report: 「切换到 MiniMax 的模型，模型能切换成功，但 base_url
 * 仍滞后不变」). `request_format` says how the request BODY is shaped; it does not
 * say which host to talk to — `base_url` is that host's address. Keeping the
 * guard also made the two resolver copies disagree (§ `resolveBaseUrl`).
 *
 * The non-empty check stays: a provider row with no address cannot answer for one.
 * NOTE (honest scope): the TS engine composes OpenAI-compatible wire format today
 * (`ENGINE_REQUEST_FORMAT` in runtime/engine-profile.ts), so a row declared
 * `anthropic_messages` is reachable but not yet spoken correctly — that is a
 * separate, pre-existing gap. This endpoint now points at the RIGHT host instead
 * of silently pointing at the wrong one.
 */
function registerDefault(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_provider_default");
  app.on(route.method, route.honoPath, async (c) => {
    const read = await readJsonBody(c);
    if (!read.ok) return read.response;
    const model = strField(c, read.body, "model");
    if (!model.ok) return model.response;
    const providerId = strField(c, read.body, "provider_id");
    if (!providerId.ok) return providerId.response;
    const wanted = (model.value ?? "").trim();
    if (wanted === "") return failJson(c, 400, "model must not be empty");
    if (deps.runtime.isBusy()) return failJson(c, 409, "a turn is running; provider default applies between turns");
    if (workersInFlight(deps.runtime)) return failJson(c, 409, "a worker is running; provider default applies between turns");
    const askedProvider = (providerId.value ?? "").trim();
    let owner: ProviderRow | undefined;
    if (askedProvider !== "") {
      owner = deps.providers.rows().find((p) => p.id === askedProvider);
      if (owner === undefined) return failJson(c, 404, `unknown provider '${askedProvider}'`);
      if (!owner.models.some((m) => m.id === wanted)) {
        return failJson(c, 400, `provider '${askedProvider}' does not list model '${wanted}'`);
      }
    } else {
      owner = deps.providers.rows().find((p) => p.models.some((m) => m.id === wanted));
    }
    const patch = owner !== undefined && owner.base_url !== "" ? { model: wanted, base_url: owner.base_url } : { model: wanted };
    try {
      await deps.runtime.configure(patch);
    } catch (e) {
      return failJson(c, 500, e instanceof EngineError ? e.message : String(e));
    }
    const saved = deps.providers.setDefaultModel(wanted);
    if (!saved.ok) return storeFail(c, saved);
    return c.json(deps.providers.response());
  });
  return route.id;
}

export function registerProviders(app: Hono, deps: Deps, table: RouteTable): string[] {
  return [registerList(app, deps, table), registerUpsert(app, deps, table), registerDelete(app, deps, table), registerTest(app, deps, table), registerModelsFetch(app, deps, table), registerDefault(app, deps, table)];
}
