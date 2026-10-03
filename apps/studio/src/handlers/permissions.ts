/**
 * The six permission endpoints (W9): custom-preset CRUD plus a session's chosen
 * preset. Storage and resolution live in store/permissions.ts and
 * runtime/engine-permissions.ts; this module is the HTTP face only.
 *
 * B5-01 (P0) — a session's chosen preset is a CAPABILITY CHANGE, so it is
 * confirmed exactly like a grant. Before this, `PUT /api/sessions/{id}/permission`
 * took a bare JSON body: the session's own `http_request` tool (which reaches
 * 127.0.0.1 by design) could raise a `read-only` session to `full-access`, and
 * with `allPaths` the path guard then allowed writing anywhere on the host. The
 * sibling endpoint `POST .../grants` had already solved exactly this threat (its
 * own header says so), so the fix REUSES that mechanism rather than inventing a
 * second one: the same one-shot token store, the same HttpOnly nonce cookie, the
 * same TTL, the same rate limiter, the same audit channel.
 *
 * What is bound into the token is the TARGET PRESET, not a free-form scope: a
 * token minted for `read-only` cannot be replayed to install `full-access`.
 * The grant store keys on `(session, cap, scope_hash)`, so the preset travels in
 * the `cap` slot under a namespaced id and its sha256 in the `scope_hash` slot
 * (both are already validated shapes in the grants flow).
 */

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { RouteTable } from "../routes.js";
import { effectivePermissionOf, permissionDataDir, type PermissionBaseline } from "../runtime/engine-permissions.js";
import { validatePermissionPreset } from "../runtime/engine-grants.js";
import {
  BUILTIN_PRESETS,
  isBuiltinPresetId,
  maxPermissionId,
  readPermissionsFile,
  readSessionPermission,
  writePermissionsFile,
  writeSessionPermission,
  type PermissionPreset,
} from "../store/permissions.js";
import { nowSec } from "../store/grants-service.js";
import {
  CONFIRM_HEADER,
  CONFIRM_TTL_SEC,
  GRANT_NONCE_COOKIE,
  SEC_FETCH_MODE,
  SEC_FETCH_SITE,
  ORIGIN_HEADER,
} from "../store/grants-tokens.js";
import { cookieValue } from "../auth/token.js";
import { errText } from "../store/result.js";
import { failJson, readJsonBody, strField, storeFail, type Deps } from "./common.js";

/** The refusal when a permission change arrives without a browser confirmation. */
export const PERMISSION_CONFIRM_REQUIRED = "permission confirmation required";
/** The cap slot a permission-change token occupies in the shared token store. */
export const PERMISSION_CAP = "permission";

/**
 * B5-01: the sha256 the confirm token is bound to.
 *
 * The target preset is part of the binding on purpose — a token minted by an
 * operator who meant to install `read-only` must not authorize `full-access`
 * (W9206-03's shape, one level up: the grant binds `scope`; this binds the
 * preset the request would actually install).
 */
function permissionScopeHash(preset: string): string {
  return createHash("sha256").update(canonicalPermissionJson(preset)).digest("hex");
}

/** The canonical, sortable single-key form the hash is taken over. */
function canonicalPermissionJson(preset: string): string {
  return JSON.stringify({ cap: PERMISSION_CAP, scope: { preset } });
}

/** `Secure` only behind TLS (nginx), same rule as the grant nonce cookie. */
function isSecureRequest(c: Context): boolean {
  const first = (c.req.header("x-forwarded-proto") ?? "").toLowerCase().split(",")[0];
  return first !== undefined && first.trim() === "https";
}

/**
 * W9206-03: the HttpOnly nonce the PUT must echo back. The mint sets it; a
 * session tool can neither read `Set-Cookie` nor guess the random value, which
 * is what makes the header checks insufficient on their own.
 */
function permissionNonceCookie(nonce: string, secure: boolean): string {
  const attrs = [
    GRANT_NONCE_COOKIE + "=" + nonce,
    "Path=/",
    "Max-Age=" + String(CONFIRM_TTL_SEC),
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * `Sec-Fetch-Site: same-origin` is the strong evidence; the CORS fallback also
 * requires an Origin matching Host. Verbatim from the grant confirm-token gate
 * (W516 §5.5.2) so the two endpoints cannot drift.
 */
function hasSameOriginEvidence(c: Context): boolean {
  if ((c.req.header(SEC_FETCH_SITE) ?? "").toLowerCase() === "same-origin") return true;
  if ((c.req.header(SEC_FETCH_MODE) ?? "").toLowerCase() !== "cors") return false;
  const origin = c.req.header(ORIGIN_HEADER) ?? "";
  const host = c.req.header("host") ?? "";
  if (origin === "") return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function presetBody(p: PermissionPreset): Record<string, unknown> {
  return {
    id: p.id,
    label: p.label,
    network: p.network,
    workspaceWritable: p.workspaceWritable,
    toolRootsWritable: p.toolRootsWritable,
    writeRoots: [...p.writeRoots],
    allPaths: p.allPaths,
    unsandboxed: p.unsandboxed,
    toolDeny: [...p.toolDeny],
  };
}

/** W864: the resolved baseline, as the two session-permission endpoints report it. */
function effectiveBody(b: PermissionBaseline): Record<string, unknown> {
  return {
    network: b.network,
    workspaceWritable: b.workspaceWritable,
    toolRootsWritable: b.toolRootsWritable,
    writeRoots: [...b.writeRoots],
    allPaths: b.allPaths,
    unsandboxed: b.unsandboxed,
    toolDeny: [...b.toolDeny],
  };
}

function registerListPresets(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_permissions_presets");
  app.on(route.method, route.honoPath, (c) => {
    const read = readPermissionsFile(permissionDataDir(deps.grants.env));
    return c.json({
      ok: true,
      builtin: BUILTIN_PRESETS.map(presetBody),
      custom: read.presets.map(presetBody),
      max: maxPermissionId(deps.grants.env),
      ...(read.warnings.length === 0 ? {} : { warnings: read.warnings }),
    });
  });
  return route.id;
}

function registerCreatePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("post_permissions_presets");
  app.on(route.method, route.honoPath, async (c) => {
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    const validated = validatePermissionPreset(body.body["preset"], deps.grants.env, read.presets.map((p) => p.id));
    if (!validated.ok) return failJson(c, validated.conflict === true ? 409 : 422, validated.error);
    try {
      writePermissionsFile(dataDir, [...read.presets, validated.preset], nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, preset: presetBody(validated.preset) });
  });
  return route.id;
}

function registerUpdatePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_permissions_preset");
  app.on(route.method, route.honoPath, async (c) => {
    const id = c.req.param("id") ?? "";
    if (isBuiltinPresetId(id)) return failJson(c, 409, "'" + id + "' is a built-in preset");
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    if (!read.presets.some((p) => p.id === id)) return failJson(c, 404, "no custom preset '" + id + "'");
    const validated = validatePermissionPreset(body.body["preset"], deps.grants.env, []);
    if (!validated.ok) return failJson(c, 422, validated.error);
    if (validated.preset.id !== id) return failJson(c, 422, "preset id must not change (" + id + ")");
    const next = read.presets.map((p) => (p.id === id ? validated.preset : p));
    try {
      writePermissionsFile(dataDir, next, nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, preset: presetBody(validated.preset) });
  });
  return route.id;
}

function registerDeletePreset(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("delete_permissions_preset");
  app.on(route.method, route.honoPath, (c) => {
    const id = c.req.param("id") ?? "";
    if (isBuiltinPresetId(id)) return failJson(c, 409, "'" + id + "' is a built-in preset");
    const dataDir = permissionDataDir(deps.grants.env);
    const read = readPermissionsFile(dataDir);
    if (!read.presets.some((p) => p.id === id)) return failJson(c, 404, "no custom preset '" + id + "'");
    try {
      writePermissionsFile(dataDir, read.presets.filter((p) => p.id !== id), nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permissions: " + errText(e));
    }
    return c.json({ ok: true, deleted: id });
  });
  return route.id;
}

function registerGetSessionPermission(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("get_session_permission");
  app.on(route.method, route.honoPath, (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const read = readSessionPermission(resolved.value.dir, resolved.value.id);
    const baseline = effectivePermissionOf(resolved.value.dir, resolved.value.id, deps.grants.env);
    const warnings = [
      ...(read.error === undefined ? [] : [read.error]),
      ...baseline.warnings,
    ];
    return c.json({
      ok: true,
      session: resolved.value.id,
      preset: read.preset ?? baseline.preset,
      effective: effectiveBody(baseline),
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  });
  return route.id;
}

/**
 * B5-01 (P0): mint a one-shot confirmation token for ONE (session, preset) pair.
 *
 * Same-origin evidence required, same HttpOnly nonce the PUT must echo, same 60s
 * TTL — the grants confirm-token gate, verbatim, with the preset in the binding.
 */
function registerPermissionConfirmToken(app: Hono, deps: Deps): void {
  // B5-01: NOT a contract endpoint (the frozen endpoint count may not move, and
  // contracts/** is outside this fix). The mint therefore REUSES the grants
  // confirm-token route the UI already calls: with cap="permission" and
  // scope_hash = sha256({cap:"permission",scope:{preset}}), the very same
  // GrantTokenStore issues a one-shot token this PUT consumes. One store, one
  // nonce cookie, one TTL, one limiter — no second mechanism to drift.
  app.get("/api/sessions/:id/permission/confirm-token", (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    if (!hasSameOriginEvidence(c)) return failJson(c, 403, "permission confirmation is not available over this transport");
    const preset = c.req.query("preset") ?? "";
    if (!isBuiltinPresetId(preset) && !readPermissionsFile(permissionDataDir(deps.grants.env)).presets.some((p) => p.id === preset)) {
      return failJson(c, 400, `invalid preset '${preset}'`);
    }
    const issued = deps.grants.tokens.issue(resolved.value.id, PERMISSION_CAP, permissionScopeHash(preset));
    c.header("set-cookie", permissionNonceCookie(issued.nonce, isSecureRequest(c)));
    return c.json({ ok: true, token: issued.token, expires_at: issued.expiresAt });
  });
}

/**
 * B5-01 (P0): the confirmation gate for a preset change, and the MAX ceiling
 * check that makes `CELESTEA_PERMISSION_MAX` fail closed on THIS path.
 *
 * Returns a response to send, or `null` when the change may proceed. Split out
 * so the handler stays inside the architecture budget and so both refusals are
 * audited through the same channel the grants endpoint uses.
 */
function confirmPermissionChange(c: Context, deps: Deps, sessionId: string, preset: string): Response | null {
  const limit = deps.grants.limits.allow(sessionId);
  if (!limit.ok) {
    return refuse(c, deps, sessionId, limit.status === 429
      ? `too many permission requests; retry in ${limit.retryAfterSec}s`
      : `a permission request was just denied; retry in ${limit.retryAfterSec}s`, limit.status);
  }
  const token = c.req.header(CONFIRM_HEADER) ?? "";
  if (token === "") return refuse(c, deps, sessionId, PERMISSION_CONFIRM_REQUIRED, 403);
  const nonce = cookieValue(c.req.header("cookie"), GRANT_NONCE_COOKIE);
  const verdict = deps.grants.tokens.consume(sessionId, PERMISSION_CAP, permissionScopeHash(preset), token, nonce);
  if (verdict === "invalid") return refuse(c, deps, sessionId, PERMISSION_CONFIRM_REQUIRED, 403);
  if (verdict === "used") return refuse(c, deps, sessionId, "confirmation token already used", 409);
  // B5-01: the deployer ceiling is checked HERE, on the write path, so a request
  // that would install a preset ABOVE the ceiling never persists. `clampByMax`
  // already narrows the resulting capabilities; refusing makes the refusal
  // legible instead of storing a preset name that no longer describes the truth.
  const max = maxPermissionId(deps.grants.env);
  if (max !== "" && !isWithinCeiling(preset, max, deps)) {
    return refuse(c, deps, sessionId, `preset '${preset}' exceeds the deployment ceiling '${max}'`, 403);
  }
  return null;
}

/**
 * true when `preset` is the ceiling itself or is not a strict widening of it.
 *
 * The comparison is the same capability set `clampByMax` narrows by, so "can
 * this preset widen past the ceiling" has ONE answer here and in
 * engine-permissions.ts. An UNREADABLE ceiling fails CLOSED (returns false).
 */
function isWithinCeiling(preset: string, max: string, deps: Deps): boolean {
  const dataDir = permissionDataDir(deps.grants.env);
  const custom = readPermissionsFile(dataDir).presets;
  const chosen = findPreset(preset, custom);
  const ceiling = findPreset(max, custom);
  if (chosen === null || ceiling === null) return false;
  return (
    (!chosen.workspaceWritable || ceiling.workspaceWritable) &&
    (!chosen.toolRootsWritable || ceiling.toolRootsWritable) &&
    (!chosen.allPaths || ceiling.allPaths) &&
    (!chosen.unsandboxed || ceiling.unsandboxed) &&
    (!chosen.network || ceiling.network) &&
    chosen.writeRoots.every((root) => ceiling.writeRoots.includes(root))
  );
}

/** Built-in first, then custom — the same lookup engine-permissions uses. */
function findPreset(id: string, custom: readonly PermissionPreset[]): PermissionPreset | null {
  const builtin = BUILTIN_PRESETS.find((p) => p.id === id);
  if (builtin !== undefined) return builtin;
  return custom.find((p) => p.id === id) ?? null;
}

/** A refusal: counted, audited (sanitized), and answered with the contract shape. */
function refuse(c: Context, deps: Deps, sessionId: string, reason: string, status: number): Response {
  deps.grants.limits.recordDenial(sessionId);
  deps.grants.audit.write({ session: sessionId, event: "deny", cap: PERMISSION_CAP, reason });
  return failJson(c, status, reason);
}

function registerPutSessionPermission(app: Hono, deps: Deps, table: RouteTable): string {
  const route = table.get("put_session_permission");
  app.on(route.method, route.honoPath, async (c) => {
    const resolved = deps.sessions.require(c.req.param("id") ?? "");
    if (!resolved.ok) return storeFail(c, resolved);
    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const preset = strField(c, body.body, "preset");
    if (!preset.ok) return preset.response;
    if (preset.value === undefined || preset.value === "") return failJson(c, 422, "field 'preset' is required");
    const read = readPermissionsFile(permissionDataDir(deps.grants.env));
    if (!isBuiltinPresetId(preset.value) && !read.presets.some((p) => p.id === preset.value)) {
      return failJson(c, 422, "unknown preset '" + preset.value + "'");
    }
    // B5-01: the confirmation gate is checked BEFORE anything is persisted, so
    // a refusal leaves the sidecar untouched (proved by the tests reading it back).
    const refused = confirmPermissionChange(c, deps, resolved.value.id, preset.value);
    if (refused !== null) return refused;
    try {
      writeSessionPermission(resolved.value.dir, resolved.value.id, preset.value, nowSec(deps.grants));
    } catch (e) {
      return failJson(c, 500, "cannot persist permission: " + errText(e));
    }
    // W9: recompose the session at the next boundary (same hook grants use).
    deps.runtime.invalidateSession?.(resolved.value.id);
    const baseline = effectivePermissionOf(resolved.value.dir, resolved.value.id, deps.grants.env);
    deps.grants.audit.write({
      session: resolved.value.id,
      event: "grant",
      cap: PERMISSION_CAP,
      scope: { preset: preset.value },
      actor: "ui:operator",
      effective_after: effectiveBody(baseline),
    });
    return c.json({ ok: true, preset: preset.value, effective: effectiveBody(baseline) });
  });
  return route.id;
}

export function registerPermissions(app: Hono, deps: Deps, table: RouteTable): string[] {
  // B5-01: the permission confirm-token mint is a SECURITY route, not a contract
  // endpoint (it returns no contract id, so the frozen count cannot move).
  registerPermissionConfirmToken(app, deps);
  return [
    registerListPresets(app, deps, table),
    registerCreatePreset(app, deps, table),
    registerUpdatePreset(app, deps, table),
    registerDeletePreset(app, deps, table),
    registerGetSessionPermission(app, deps, table),
    registerPutSessionPermission(app, deps, table),
  ];
}
