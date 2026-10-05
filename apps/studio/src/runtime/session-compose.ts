/**
 * SessionComposer — `compose()` for ONE session (W513).
 *
 * Every session runtime is one self-consistent generation: its own profile
 * snapshot (base profile + the session's `session.json` model override), its own
 * session binding (`<dir>/cli-main.jsonl` or an in-memory log when detached),
 * its own usage tracker, its own agent loop instance and its own worker
 * registry. Nothing is shared but the process (and the LLM seam factory), which
 * is exactly what makes two sessions unable to see each other's history.
 *
 * The module also owns the resource caps and the two error channels the host
 * maps onto HTTP 503, so the adapter itself stays about the HTTP contract.
 */

import { createUsageTracker, DefaultAgentLoop, withRepetitionPerturbation, type RepetitionDiagnostics } from "@celestea/agent-loop";
import { type CompressionHost, type Llm, type PendingInjection, type Sandbox, type SessionEvent, type SessionLog, type Tool, type ToolGuard } from "@celestea/core";
import { createSessionInbox, type SessionInbox } from "@celestea/runtime";
import {
  createLedgerLlm,
  createUsageLedger,
  hostOf,
  HOST_SESSION_ID,
  type UsageLedger,
  type UsageLedgerFile,
} from "@celestea/runtime";
import { InMemorySessionLog } from "@celestea/session";
import {
  compose,
  compressionHostOf,
  createMemoryExtractionScheduler,
  llmSummarizer,
  memoryExtractionEnabled,
  repeatGuardDisabled,
  repeatGuardSettingsOf,
  SessionCapacityError,
  TurnCapacityError,
  type ExtractionCursor,
  type ExtractionCursorStore,
  type MemoryExtractionScheduler,
  type Profile,
  type Runtime,
  type SessionBinding,
  type Summarizer,
  type WatchdogMountSettings,
  type WorkerWiring,
} from "@celestea/runtime";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapacityError } from "../runtime-adapter.js";
import { bindingFor, closeLog, workerSessionPrefix, type CheckpointWiring, type SessionTarget } from "./engine-session.js";
import { DEFAULT_SESSION_MODE, effectiveMode } from "../store/mode.js";
import { enginePlugins, type DisclosureOptions, type QuestionWiring } from "./engine-plugins.js";
import type { EnginePluginSwitches } from "../plugin-catalog.js";
import type { PendingQuestion, QuestionRegistry } from "../question-registry.js";
import { questionAnsweredRow, questionAskedRow } from "../question-rows.js";
import { EMPTY_GRANTS } from "./engine-grants.js";
import { createEngineLlm, liveEngineLlm } from "./llm-assembly.js";
import type { FallbackWiring } from "./fallback-host.js";
import { workerTablePath } from "./worker-table.js";
import type { RecoveryAuditWriter } from "./recovery-audit.js";
import type { SessionGrantsReader } from "./session-grants.js";
import {
  applyMemoryExtractionOp,
  ATTACHMENTS_DIRNAME,
  createAttachmentStore,
  MEMORY_ENTRY_MAX_BYTES,
  memoryManifest,
  memoryStoreOf,
  type AttachmentStore,
  type RunCodeEventSink,
} from "@celestea/tools";
import { createImageDowngradeLlm, resolveLlmMode, type ImageDowngradeInfo, type Llm as ProviderLlm } from "@celestea/llm";
import { withAttachments } from "./attachments-llm.js";
import { goalNotice, goalTurnContext, turnContextFor } from "./goal-wiring.js";

/** W510 resource caps (overridable through the adapter options or the env). */
export const MAX_LIVE_SESSIONS = 4;
export const MAX_CONCURRENT_TURNS = 2;
export const SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;

/** Extraction cursor sidecar name inside the session directory (Phase 1). */
export const MEMORY_EXTRACTION_CURSOR_FILE = "memory-extraction.json";
/** Env override for the extraction client's reasoning tier (default "low"). */
export const ENV_MEMORY_EXTRACTION_EFFORT = "CELESTEA_MEMORY_EXTRACTION_EFFORT";

/**
 * W9228 (W9225 F-09): the repetition guard's sidecar names, INSIDE the session
 * directory — the same "carried along by trash/archive/delete" rule the
 * attachment store follows. Declared here (the composer owns the session dir)
 * so the two paths can never drift from the loop that writes them.
 */
export const REPETITION_LOG_NAME = "repetitions.jsonl";
export const REPETITION_COPY_DIRNAME = "repetitions";

/**
 * Per-session injection wiring the host supplies (placement over SSE, W515 §2).
 * The HOST builds it in `session-publisher.ts`; the fields are optional here
 * because a session with no observers gets a plain inbox and no callback.
 */
export interface SessionInjectionHooks {
  /** The session's inbox (default: a plain one with no observers). */
  inbox?: SessionInbox;
  /** Called when a message LEAVES a lane and becomes model-visible history. */
  onInjected?: (messages: readonly PendingInjection[], boundary: "turn-start" | "step") => void;
}

export interface SessionComposerOptions {
  env: NodeJS.ProcessEnv;
  /** Build the injection hooks of one session instance (inbox + observer). */
  sessionHooks?: (sessionId: string | null) => SessionInjectionHooks;
  /** BASE profile (the `/api/config` one); sessions add their model override. */
  baseProfile: () => Profile;
  /** Host lookup: `<workspace>/<session>` -> directory (null = detached). */
  resolveSession?: (id: string) => SessionTarget | null;
  /**
   * W1479: does this session actually EXIST on disk?
   *
   * Deliberately separate from [resolveSession]: that hook answers "where would
   * this session live", which the composer needs for sessions it is about to
   * CREATE (a not-yet-written id must still resolve to its target directory).
   * The worker-table probe asks a different question — "is the host conversation
   * that dispatched this row still here?" — and answering it with a
   * location-shaped lookup made every host look alive.
   *
   * Absent = "cannot tell", which the recovery judgement already treats as
   * "never an orphan" (no guessing without evidence).
   */
  hostExists?: (id: string) => boolean;
  /** Session-level model override (`session.json`), applied per instance. */
  sessionModel?: (id: string) => string | null;
  /**
   * W2065: the endpoint that session-level model override was resolved against
   * (`session.json.base_url`). Kept as a SEPARATE hook rather than folded into
   * `sessionModel` because `Profile` is the frozen 12-key contract and this
   * assembles a `Partial<Profile>`. Absent = 「the session pinned no endpoint,
   * follow the global base_url」.
   */
  sessionBaseUrl?: (id: string) => string | null;
  /**
   * W729: session-level mode (`session.json.mode`; null = the session never
   * declared one). Consumed by the worker wiring, so a worker's row/receipt can
   * record the mode of the session that spawned it (§2.3).
   */
  sessionMode?: (id: string) => string | null;
  /**
   * W729 (§5.1 #4, R3): the session's OWN system prompt. Without this hook the
   * process would assemble ONE prompt at startup and every session would share
   * it — the mode would then only hold for the focused session. `null` = "use
   * the base profile prompt" (a session with no declared mode, K8).
   */
  sessionSystemPrompt?: (id: string) => string | null;
  /**
   * E §4 P1 (W785): the model-fallback wiring. `wrap()` returns null while the
   * capability is off (`CELESTEA_LLM_FALLBACK` unset — the default), so the
   * pre-P1 path stays byte-for-byte identical (D9); when armed it returns the
   * decorated seam and the ledger is booked PER ATTEMPT by the decorator
   * instead of once per call, which is what makes D6's rows possible.
   */
  fallback?: FallbackWiring | null;
  /** LLM seam factory; default = the assembled engine LLM (live provider). */
  llm?: (profile: Profile) => Llm;
  /** Extra tools registered after the six builtins. */
  tools?: readonly Tool[];
  /**
   * W806 (P0): dynamic tool disclosure for the composed sessions. Absent = the
   * static mode baseline (byte-identical face). Present = a reduced initial set
   * is offered and the rest is revealed one turn at a time. The DETACHED
   * generation never takes it: it backs `{{tools}}` / `GET /api/tools`, which
   * must keep announcing the static disclosable universe (S3).
   */
  disclosure?: DisclosureOptions;
  sandbox?: Sandbox;
  /** Guard override: `undefined` = production guard, `null` = no guard. */
  guard?: ToolGuard | null;
  /** Disable worker orchestration wiring entirely. */
  workers?: false;
  /**
   * W740: the liveness watchdog over this session's worker registry. Omitted =
   * the environment decides (`compose()` reads it); `false` never mounts it.
   * The sweep timer dies with the instance (the runtime's shutdown hook), so a
   * reclaimed session leaks nothing.
   */
  watchdog?: Partial<WatchdogMountSettings> | false;
  /** Worker receipt/report directory (default `<cwd>/worker-results`). */
  resultsDir?: string;
  /**
   * E §2.3 P0 ①: the worker table this process writes. `undefined` = derive it
   * (`CELESTEA_WORKER_REGISTRY`, else `<data dir>/worker-registry.tsv`);
   * `null` = IN-MEMORY only, which stays a first-class option for tests and
   * embedded hosts (B6 is about the DEFAULT, not about removing the choice).
   */
  workerRegistryPath?: string | null;
  /** `<data dir>` — the default home of that table (see `worker-table.ts`). */
  dataDir?: string | null;
  /** Compact summarizer override (default: the `Llm` seam). */
  summarize?: (profile: Profile) => Summarizer;
  /**
   * Session grants reader (W516 §4.2): read at every compose, so a grant or a
   * revocation is visible at the session's next turn boundary and never inside
   * a running turn. Absent = no grants at all (tests, embedded use).
   */
  grants?: SessionGrantsReader;
  /**
   * W728 §3 P0: the process-shared append-only usage ledger. Absent/null = this
   * generation books nothing (tests, embedded use); the studio host creates ONE
   * file per process (`<data dir>/usage-ledger.jsonl`) and every session
   * instance books its own rows into it.
   */
  ledgerFile?: UsageLedgerFile | null;
  /** Provider row id of the startup target, recorded as the ledger's `provider`. */
  providerLabel?: string | null;
  /**
   * E §1.3 P0 ②: checkpoint sidecar wiring. A persistent session log is always
   * checkpointed; this only overrides the process identity (`boot_id`/`pid`) and
   * the clock, which tests pin to keep the written file deterministic.
   */
  checkpoint?: CheckpointWiring;
  /**
   * W787 (§5.2③): the audit channel of the recovery facts this process observes
   * (a degraded session log). Absent = no audit line is written.
   */
  recoveryAudit?: RecoveryAuditWriter | null;
  now?: () => number;
  /**
   * W783: the process-wide pending-question table. Present = every composed
   * session offers `ask_user_question`; absent = no session does (tests and
   * embeddings that have no human answerer).
   */
  questionRegistry?: QuestionRegistry | null;
  /**
   * W783: publish one parked question as a `question` SSE frame. The composer
   * supplies it (it knows the session id and can reach the bus); absent = the
   * frame is not emitted, which no production host wants.
   */
  publishQuestion?: (sessionId: string | null, question: PendingQuestion) => void;
  /**
   * W804: the configured input_modalities of one model id, or null when the
   * model is unknown/unconfigured (=> optimistic default: image input allowed).
   */
  modelInputModalities?: (modelId: string) => readonly string[] | null;
  /**
   * W804 (section 7.6): a model rejected image input and the turn was downgraded
   * to text + placeholders. The host turns this into the three visible channels
   * (info block / statusline / audit).
   */
  onModelDowngrade?: (sessionId: string | null, info: ImageDowngradeInfo) => void;
  /**
   * W1467: publish one `run_code` SUB-CALL row as an SSE frame (the host owns the
   * bus and the turn number). Absent = sub-calls are still logged, just not
   * streamed live — a host that omits it gets the replay tree only.
   */
  publishRunCodeEvent?: (sessionId: string | null, event: SessionEvent) => void;
  /**
   * 插件热插拔（`docs/feature-plugin-hotswap.md` §3.1/§6.2）：**本代要关掉的引擎层
   * 插件**，late-bound 读取。
   *
   * 为什么是**读取函数**而不是一个快照数组：换代必须发生在 turn 边界，而
   * `compose()` 正是那个边界。如果这里存一份 compose 时刻的副本，`composeStudio`
   * 就得在每次开关变更时把它推给每一个 composer——多一条会漂移的通道。让 composer
   * 在**每次 compose 时**读一次当前值，就没有第二份状态。
   *
   * 缺省 = 全部 mount（逐字节等于热插拔之前的行为）。
   */
  pluginSwitches?: () => EnginePluginSwitches;
}

/** Non-negative integer from the environment, else the frozen default. */
export function limitFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Shut one instance down and close its log descriptor (order matters). */
export async function disposeRuntime(runtime: Runtime): Promise<void> {
  const log = runtime.session;
  await runtime.shutdown();
  closeLog(log);
  runtime.release();
}

/** Wrap the registry caps into the ONE error the HTTP layer maps to 503. */
export function capacityErrorOf(e: unknown): unknown {
  if (e instanceof SessionCapacityError) return new CapacityError(`too many live sessions (limit ${e.limit})`);
  if (e instanceof TurnCapacityError) return new CapacityError(`too many concurrent turns (limit ${e.limit})`);
  return e;
}

export class SessionComposer {
  private readonly memoryLogs = new Map<string, SessionLog>();

  constructor(private readonly opts: SessionComposerOptions) {}

  /**
   * W1900: the compression host of THIS generation, plus the holder that
   * carries the late-bound runtime — kept out of `compose()` so that method
   * stays inside its line budget while this keeps its reasoning.
   *
   * The tools are built BEFORE `compose()` returns the log they act on, so the
   * host closes over a holder the same way the question and run_code wirings
   * do — and the holder is the `Runtime.session` GETTER, so the `rebind()` a
   * reopened session performs is picked up instead of stranding a dead log. The
   * water level is the runtime's OWN `contextUsageFacts()`, i.e. the number
   * /api/status reports: one plane, three readers.
   *
   * This is mounted for the DETACHED generation too, and it has to be: the
   * studio's reported tool face is derived from THAT generation's registry
   * (`RealRuntimeAdapter.sessionTools` reads `registry.peek(null)` and then
   * applies the session's mode — see its comment for why the face must not come
   * from "whichever instance happens to be live"), and the session prompt's
   * `{{tools}}` is rendered from the same list. Gating the mount on "there is a
   * session" therefore removes the trio from EVERY session's face and prompt,
   * not just from the detached one — measured: 22 names became 19.
   *
   * Advertising it is not the same as being able to run it: a detached runtime
   * has no log, so its port is null and every call answers `no_session` — the
   * honest answer, and the same shape `ask_user_question` takes when no
   * question service is mounted.
   */
  private compressionWiring(): {
    holder: { runtime: Runtime | null };
    option: { compression?: CompressionHost };
  } {
    const holder: { runtime: Runtime | null } = { runtime: null };
    const compression = compressionHostOf({
      log: () => holder.runtime?.session ?? null,
      usage: () => holder.runtime?.contextUsageFacts() ?? null,
    });
    return { holder, option: compression === null ? {} : { compression } };
  }

  /** Compose one session generation (the registry's build factory). */
  compose(sessionId: string | null, dir: string | null): Runtime {
    const profile = this.profileFor(sessionId);
    // 插件热插拔（`docs/feature-plugin-hotswap.md` §3.1）：**就在这个边界**读一次
    // 当前的开关。`compose()` 是「一代」的构造点，所以「开关变更在下一 turn 边界
    // 生效」不需要任何额外机制——`invalidateAll()` 把实例标脏，下一次 `ensure()`
    // 走到这里，读到的就是新值。
    const switches = this.opts.pluginSwitches?.() ?? { tools: false, workers: false, swarm: false, watchdog: false, repeatGuard: false };
    // W804 (multimodal P0 section 5): the session's attachment store. It lives
    // INSIDE the session directory, so trash/archive/delete carry it along. The
    // DETACHED generation (dir === null, the face /api/tools and the default
    // prompt read) gets a host-level store so read_image is part of the SAME face
    // every session's prompt advertises; a session-less turn is the only caller
    // that could ever write there.
    const attachments = createAttachmentStore(
      dir === null ? join(tmpdir(), "celestea-detached-attachments") : join(dir, ATTACHMENTS_DIRNAME),
    );
    // Optimistic default (section 7.1): only an EXPLICIT input_modalities without
    // "image" disables the read_image gate; an unknown model stays optimistic.
    const modalities = this.opts.modelInputModalities?.(profile.model) ?? null;
    const imageInputAllowed = modalities === null ? true : modalities.includes("image");
    // W768: the session's OWN workspace, taken from the same resolution the
    // system prompt renders (the host's `resolveSession` hook). A session with no
    // resolvable workspace keeps the process env posture — never a failure.
    const workspace = sessionId === null ? null : (this.opts.resolveSession?.(sessionId)?.workspace ?? null);
    // W9346 + W884: the goal's two halves and the skill/memory context, both
    // rebuilt at every turn start (goal-wiring.ts holds the reasoning — the
    // composer sits exactly at its 450-line cap). A detached generation has no
    // session directory and no workspace, so it contributes nothing.
    const notice = goalNotice(sessionId, dir);
    const turnContext = turnContextFor(workspace === null ? null : workspace.path, goalTurnContext(sessionId, dir), this.opts.env);    const reader = this.opts.grants;
    const read = reader?.read(sessionId, dir) ?? { grants: EMPTY_GRANTS, warnings: [] };
    // W728: the ledger must exist before the Llm wrapper (every step books).
    const ledger = this.usageLedger(sessionId, dir);
    // Phase 1: background memory extraction — OPT-IN (CELESTEA_MEMORY_EXTRACTION=on);
    // absent/off is the default, because it is an extra billed call per turn.
    const extraction = this.memoryExtraction(sessionId, dir, workspace, profile, ledger);
    // W783: the question wiring of THIS generation. The runtime handle does not
    // exist until `compose()` below returns, so the wiring reaches it through a
    // holder it fills in immediately afterwards — the same late-binding the
    // `isLive` probe and the log write both need.
    const questionHolder: { runtime: Runtime | null } = { runtime: null };
    const questions = this.questionWiring(sessionId, questionHolder);
    // W1467: the same late-binding trick for `run_code` sub-calls — the sink is
    // handed to the tool assembly BEFORE `compose()` returns the log it must
    // append to, so the runtime travels through a holder.
    const runCodeHolder: { runtime: Runtime | null } = { runtime: null };
    const onRunCodeEvent = this.runCodeSink(sessionId, runCodeHolder);
    const compression = this.compressionWiring();
    // 插件热插拔（§3.1/§4）：关掉引擎层插件的两条路，各有各的理由。
    //
    // ① **工具插件走 `emptyTools`，不走 `disabled`**：`TOOL_REGISTRY_SERVICE` 是
    //    `resolveSeams()` 的必需 seam，不 provide 它整代会在第一个 turn 抛
    //    `missing ToolRegistryService in context`。所以「关掉工具」= 注册表照旧
    //    provide 但**里面一个工具都没有**（连 `run_code` 也没有），于是
    //    `GET /api/tools` 与 prompt 的 `{{tools}}` 在同一个 `compose()` 里一起变空——
    //    这正是 contracts/tools.json 那条单一真源要求的原子性。
    // ② **其它引擎插件走 `disabled`**（真的不 mount）：它们提供的服务都不是必需 seam。
    //
    // 工具装配即使一个工具都不注册也照样构造：`Runtime.shutdown` 要靠
    // `engine.tools.processes.dispose()` 回收本代 `run_shell background:true`
    // 派生的子进程（W855 #1）。
    const engine = enginePlugins({
      profile,
      // W791 (P1, §5.2 #2): the mode decided at compose time. The DETACHED
      // generation never asks the hook (its id is not addressable), a session
      // without a declared mode reads as `standard` (K8), and both compose the
      // whole registry — so nothing about a pre-P1 generation changes.
      mode: sessionId === null ? DEFAULT_SESSION_MODE : effectiveMode(this.opts.sessionMode?.(sessionId) ?? null),
      workspace: workspace === null ? null : { workspace: workspace.path },
      ...(questions === null ? {} : { questions }),
      attachments,
      imageInputAllowed,
      llm: this.engineLlm(sessionId, profile, ledger, attachments),
      workers: null, // the workers plugin registers the three tools, in compose order
      // `EnginePluginInput.emptyTools`（这里）= 「装配一个**空**注册表」；
      // `ComposeConfig.emptyTools`（下面那处）= 「这一代的工具面是空的」。
      // 两个都要传，而且必须成对：前者让 `GET /api/tools` / prompt 的 `{{tools}}`
      // 变空，后者让 compose 不再让 workers / swarm 往注册表里注册。
      ...(switches.tools ? { emptyTools: true } : {}),
      ...(this.opts.disclosure === undefined || sessionId === null ? {} : { disclosure: this.opts.disclosure }),
      ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
      ...(this.opts.sandbox === undefined ? {} : { sandbox: this.opts.sandbox }),
      ...(this.opts.guard === undefined ? {} : { guard: this.opts.guard }),
      grants: read.grants,
      ...(reader === undefined ? {} : { audit: reader.audit(sessionId) }),
      env: this.opts.env,
      ...(onRunCodeEvent === undefined ? {} : { onRunCodeEvent }),
      ...compression.option,
    });
    // After the boundary is built: audit the generation and spend one-shots, so
    // THIS turn keeps its grants and the next one sees the consumption.
    reader?.onComposed(sessionId, dir, read);
    const usage = createUsageTracker();
    const hooks = this.opts.sessionHooks?.(sessionId) ?? {};
    // W9331: resolve the guard settings ONCE, here, and hand the same object to
    // both the loop factory and `compose()`'s mount. Resolving twice would be two
    // truths: a threshold edited between the two calls would mount a plugin
    // advertising one budget and drive a loop with another.
    const repeatGuard = switches.repeatGuard
      ? null
      : repeatGuardDisabled(this.opts.env ?? process.env)
        ? null
        : repeatGuardSettingsOf();
    const composed = compose({
      profile,
      plugins: engine.plugins,
      sessionBinding: this.bindingTo(sessionId, dir),
      // W855 #1: reap detached `run_shell background:true` children on shutdown.
      // The composer holds the registry from `engine.tools`; runtime is L2 and
      // may not import @celestea/tools, so the hook is wired HERE (host side).
      // Phase 1: drain queued extraction too — idle-TTL eviction runs these
      // same hooks (disposeRuntime awaits runtime.shutdown()).
      shutdownHooks: [
        () => engine.tools.processes.dispose(),
        ...(extraction === undefined ? [] : [() => extraction.drain()]),
      ],
      usage,
      ...(ledger === null ? {} : { ledger }),
      inbox: hooks.inbox ?? createSessionInbox(),
      ...(hooks.onInjected === undefined ? {} : { onInjected: hooks.onInjected }),
      ...(turnContext === undefined ? {} : { turnContext }),
      // W9346: the change notice reaches the model AFTER the turn's input row,
      // which is inside the loop — so it is a compose-level option, not a loop
      // binding this factory sets by hand.
      ...(notice === undefined ? {} : { afterInput: notice }),
      ...(extraction === undefined ? {} : { extraction }),
      loopFactory: (bindings) => {
        // W806: the turn boundary is the ONLY place the disclosed set may move.
        engine.tools.disclosure.beginTurn();
        // W9228 (W9225 F-09): the repetition guard's diagnostics sink. Until now
        // NOTHING in production passed `repetitionDiagnostics`, so
        // `CollapseDriver.log()` returned on its first line for every conviction
        // and the module's promise ("the ONLY surviving record of what was
        // discarded", repetition-recovery.ts) was never kept: a collapse dropped
        // the whole attempt with no `repetitions.jsonl` line and no copy.
        // `sessionId` rides along so the line names the session instead of null.
        const diagnostics = this.repetitionDiagnosticsFor(dir);
        return new DefaultAgentLoop(bindings.config, {
          signal: bindings.signal,
          sink: bindings.sink,
          usage,
          ...(bindings.injections === undefined ? {} : { injections: bindings.injections }),
          ...(diagnostics === null ? {} : { repetitionDiagnostics: diagnostics }),
          sessionId,
          // W9331: the thresholds, retry budget and sanitize arm now come from
          // the ONE settings object the engine-level guard plugin resolved. Before
          // W9331 this loop took the package defaults implicitly, which meant the
          // hot-swap catalog could switch the guard OFF (`repeatGuard: false` in
          // `compose()`) and the loop would have carried on guarding anyway — the
          // switch would have been a lie. `null` = the plugin was not mounted
          // (switched off or not composed), and the guard is genuinely absent.
          ...(repeatGuard === null
            ? { repetition: false as const }
            : {
                repetition: repeatGuard.repetition,
                repetitionRetries: repeatGuard.retries,
                sanitizeGarbage: repeatGuard.sanitize,
                garbageThresholds: repeatGuard.garbage,
              }),
          // W1900: the nudge's water level. `compose()` already wired the same
          // reader into the turn runner; passing it through keeps the studio
          // loop byte-identical to the headless one instead of diverging into
          // a second estimate. `undefined` is a valid loop binding (no nudge).
          // W9346: `afterInput` (the goal's change notice) rides down the same
          // way — the runner holds the source for its suppression peek, and the
          // loop writes the row because the position after the input is its own.
          ...(bindings.contextUsage === undefined ? {} : { contextUsage: bindings.contextUsage }),
          ...(bindings.afterInput === undefined ? {} : { afterInput: bindings.afterInput }),
        });
      },
      // 插件热插拔（§3.2）：三个开关各自对应一个真实的装配点。`false` 与
      // `undefined` 在这里**不等价**——`undefined` 走环境默认（watchdog 默认开），
      // 所以「关掉」必须显式传 `false`，不能靠省略。
      workers: switches.workers ? false : this.workerWiring(sessionId, profile),
      // agent_swarm (feature §5.3): the swarm plugin needs the SAME loopFactory
      // the host turn uses, because a member IS a one-shot turn. Passing it here
      // is what makes the tool exist at all — `ensureSwarmWiring` mounts nothing
      // without a loopFactory (a member turn cannot be built), so omitting this
      // line silently produced "unknown tool: agent_swarm" in production.
      swarm: switches.swarm ? false : this.swarmWiring(),
      // W9331: `null` = the guard plugin is NOT mounted (the host switched it
      // off, or the environment did), which is what makes `repeatGuard` in the
      // loop factory above genuinely absent rather than defaulted-on.
      ...(repeatGuard === null ? { repeatGuard: false as const } : { repeatGuard }),
      // W740: the watchdog settings come from the process environment; the
      // composition root reads them and registers the stop hook with the sweep.
      env: this.opts.env,
      // 插件热插拔：`emptyTools` 由**这一个**布尔量表达「这一代没有工具」，
      // 由 `compose()` 统一落实（它同时压掉 workers 与 swarm 两条注册路径）。
      ...(switches.tools ? { emptyTools: true } : {}),
      ...(switches.watchdog ? { watchdog: false as const } : this.opts.watchdog === undefined ? {} : { watchdog: this.opts.watchdog }),
      ...(this.opts.now === undefined ? {} : { now: this.opts.now }),
    });
    // W783: bind the just-composed runtime into the question wiring, so
    // `isLive` and the `user_question` log row address THIS generation.
    questionHolder.runtime = composed;
    runCodeHolder.runtime = composed; // W1467: same late binding for sub-call rows
    compression.holder.runtime = composed; // W1900: the compression tools' port
    return composed;
  }

  /**
   * W9228 (W9225 F-09): the repetition guard's diagnostics sink of ONE session
   * generation, or null for a generation with no directory (the detached
   * face): a session-less turn has nowhere to write, and inventing a path would
   * scatter sidecars across the process CWD.
   *
   * Both names live INSIDE the session directory, so archive / trash / delete
   * carry the evidence along exactly like `attachments/` does — a conviction
   * record that survives the session it describes is the whole point.
   *
   * ## Why `holdbackChars` is NOT set here (the reason this is not a one-liner)
   *
   * `RepetitionDiagnostics` also carries `holdbackChars`, which makes the cut
   * land on the true onset instead of at the (later) conviction point. The
   * audit's suggested fix passed it. Measured here (`results/w9228-probe-holdback.ts`,
   * a 4 960-char HEALTHY burst through the real `ThinkingBuffer`):
   *
   *     holdback=0    → persisted 4960 / pushed 4960   (完整)
   *     holdback=2400 → persisted 2560 / pushed 4960   (LOST 2400)
   *
   * i.e. on the HEALTHY path the trailing `holdbackChars` of every reasoning
   * burst are never released: `releaseAfterStream` calls `thinking.flush()`,
   * and `flush()` only releases `held - holdbackChars` ([ThinkingBuffer.releasable]).
   * The only caller that would release the remainder is the TRUNCATE arm of
   * `repetition-cut.ts`, which a healthy turn never reaches. Turning it on from
   * here would silently truncate the tail of every normal turn's reasoning —
   * strictly worse than the defect being fixed. `holdbackChars` therefore stays
   * at its default 0, and the missing flush is registered as a cross-grid clue.
   */
  private repetitionDiagnosticsFor(dir: string | null): RepetitionDiagnostics | null {
    if (dir === null) return null;
    return {
      logPath: join(dir, REPETITION_LOG_NAME),
      copyDir: join(dir, REPETITION_COPY_DIRNAME),
    };
  }

  /**
   * W1467: the `run_code` sub-call sink of ONE session generation.
   *
   * Two halves, and BOTH are required for the feature to be coherent:
   *   · append the row to this session's log — the row carries `parent_id`, the
   *     Studio projection turns it into `tool_parent_id`
   *     (`packages/session/src/messages.ts`), and a refresh replays the tree;
   *   · publish it on this session's bus — without the live half the streamed
   *     view would render a flat top-level card and a refresh would indent it,
   *     which is precisely the live/replay divergence this repo forbids.
   *
   * Best-effort by construction, like every other frame and row on this path: a
   * released generation drops the frame (the W794 rule) and a log that refuses
   * the write already reports itself through the log's degraded channel — a
   * sub-call row is audit-only and must never break the program that made it.
   *
   * Returns undefined when the host wired no publisher, so the tool assembly can
   * skip mounting the sink entirely (byte-identical pre-W1467 behaviour).
   */
  private runCodeSink(
    sessionId: string | null,
    holder: { runtime: Runtime | null },
  ): RunCodeEventSink | undefined {
    const publish = this.opts.publishRunCodeEvent;
    if (publish === undefined) return undefined;
    return (event: SessionEvent): void => {
      const runtime = holder.runtime;
      if (runtime === null || runtime.isReleased) return;
      try {
        runtime.session.append(event);
      } catch {
        /* audit-only row: the log's own degraded channel reports the failure */
      }
      publish(sessionId, event);
    };
  }

  /**
   * W783: the user-question wiring of ONE session generation, or null when the
   * host mounted no table (the tool is then not offered to the model at all).
   *
   * The bus is the SESSION's own (`compose()` provides it), filled in by the
   * plugin body: an answerer chain per generation is what stops a question asked
   * in one session from being answered into another.
   */
  private questionWiring(
    sessionId: string | null,
    holder: { runtime: Runtime | null },
  ): QuestionWiring | null {
    const registry = this.opts.questionRegistry;
    if (registry === undefined || registry === null) return null;
    return {
      registry,
      sessionId,
      bus: { current: null },
      isLive: () => holder.runtime !== null && !holder.runtime.isReleased,
      publish: (question) => this.opts.publishQuestion?.(sessionId, question),
      record: (question) => holder.runtime?.session.append(questionAskedRow(question)),
      recordAnswer: (requestId, answers, timedOut) =>
        holder.runtime?.session.append(questionAnsweredRow(requestId, answers, timedOut)),
    };
  }

  /**
   * The session's ledger, or null when the host did not wire one. The session
   * label is the file's self-description (`<workspace>/<session>`, §3.2.1).
   *
   * W878: `compose(sessionId, dir)` already carries the trusted id, so the label
   * uses it directly and only falls back to `HOST_SESSION_ID` when the id is
   * null (the detached generation). `dir` is kept in the signature for the
   * caller but is deliberately no longer a source of the label.
   */
  private usageLedger(sessionId: string | null, dir: string | null): UsageLedger | null {
    void dir;
    const file = this.opts.ledgerFile;
    if (file === undefined || file === null) return null;
    return createUsageLedger({ session: sessionId ?? HOST_SESSION_ID, file });
  }

  /**
   * Phase 1 (background memory extraction, docs/feature-memory-extraction.md
   * §4): the session's extraction scheduler. Everything store- or
   * process-bound is wired HERE because runtime may not import
   * @celestea/tools: the write callback applies ops to the workspace's GLOBAL
   * memory layer (with the session/turn provenance on every entry), the
   * manifest is re-read per call, and the cursor lives in a sidecar file
   * inside the session directory so trash/archive carry it along. The
   * extraction client is the session's OWN model pinned to the cheapest
   * reasoning tier (CELESTEA_MEMORY_EXTRACTION_EFFORT overrides) with a 2048
   * output cap. Detached generations and workspace-less sessions get none.
   */
  private memoryExtraction(
    sessionId: string | null,
    dir: string | null,
    workspace: { readonly path: string } | null,
    profile: Profile,
    ledger: UsageLedger | null,
  ): MemoryExtractionScheduler | undefined {
    if (sessionId === null || dir === null || workspace === null) return undefined;
    if (!memoryExtractionEnabled(this.opts.env)) return undefined;
    // The offline test seam has no real model behind it — composing a live
    // extraction client there would fire REAL network calls from tests.
    if (resolveLlmMode(this.opts.env) === "offline") return undefined;
    const store = memoryStoreOf(workspace.path, { env: this.opts.env });
    const effort = (this.opts.env[ENV_MEMORY_EXTRACTION_EFFORT] ?? "").trim() || "low";
    const llm = liveEngineLlm({ ...profile, reasoning_effort: effort, max_output_tokens: 2048 }, this.opts.env);
    return createMemoryExtractionScheduler({
      llm,
      model: profile.model,
      write: (op, turnId) => applyMemoryExtractionOp(store, op, turnId === null ? null : { session: sessionId, turn: turnId }),
      manifest: () => memoryManifest(store),
      ...(ledger === null
        ? {}
        : {
            bookExtraction: (input) =>
              ledger.bookExtraction({
                ...input,
                provider: this.opts.providerLabel ?? null,
                model: profile.model,
                base_url_host: hostOf(profile.base_url),
              }),
          }),
      cursor: this.extractionCursorStore(join(dir, MEMORY_EXTRACTION_CURSOR_FILE)),
      entryMaxBytes: MEMORY_ENTRY_MAX_BYTES,
      stderr: (line) => process.stderr.write(`[${sessionId}] ${line}\n`),
    });
  }

  /** The extraction cursor sidecar (one JSON line in the session dir; a corrupt file just resets the cursor). */
  private extractionCursorStore(file: string): ExtractionCursorStore {
    return {
      load: (): ExtractionCursor | null => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
        } catch {
          return null;
        }
        if (typeof parsed !== "object" || parsed === null) return null;
        const o = parsed as Record<string, unknown>;
        return typeof o["turn_id"] === "string" && typeof o["event_count"] === "number"
          ? { turn_id: o["turn_id"], event_count: o["event_count"] }
          : null;
      },
      save: (cursor) => {
        try {
          writeFileSync(file, JSON.stringify(cursor) + "\n", "utf8");
        } catch {
          // Best-effort: a lost cursor only re-scans, and the store dedups.
        }
      },
    };
  }

  /**
   * E §4 P1 (W785): the ONE place a composed generation decides which `Llm` it
   * runs on. Fallback OFF (or unwired) = the W728 path unchanged (ledger wrapper
   * around the raw seam). Fallback ON = the decorator, which books one ledger
   * row per ATTEMPT and hands the switch to the next target.
   */
  private engineLlm(sessionId: string | null, profile: Profile, ledger: UsageLedger | null, attachments: AttachmentStore | null): Llm {
    // W1510: the perturbation must be the OUTERMOST wrapper, because it is the
    // seam the loop asks (isPerturbable) before re-issuing a collapsed attempt.
    // Wrapping it deeper would make that retry silently unperturbed; wrapping it
    // here means apply() rebuilds the WHOLE chain on the new effort, so the
    // ledger, fallback and attachment layers survive the re-issue.
    return withRepetitionPerturbation(this.llmChain(sessionId, profile, ledger, attachments), {
      currentEffort: profile.reasoning_effort,
      apply: (effort) => this.llmChain(sessionId, { ...profile, reasoning_effort: effort }, ledger, attachments),
    });
  }

  /** The decorated LLM chain for one route (everything except perturbation). */
  private llmChain(sessionId: string | null, profile: Profile, ledger: UsageLedger | null, attachments: AttachmentStore | null): Llm {
    const inner = this.llmFactory()(profile);
    const wrapped =
      this.opts.fallback?.wrap({
        inner,
        profile,
        sessionId,
        steps: ledger,
        provider: this.opts.providerLabel ?? null,
      }) ?? null;
    const observed = wrapped ?? this.stepObservedLlm(inner, profile, ledger);
    // W804: resolve image references to a REQUEST-scoped data-URL table (inner),
    // then downgrade once on an "image unsupported" 400 (outer). The downgrade
    // decorator is provider-seam typed; it only forwards streams, so the cast is
    // a type-level bridge (same pattern as fallback-host.ts).
    const resolved = withAttachments(observed, attachments);
    return createImageDowngradeLlm({
      inner: resolved as unknown as ProviderLlm,
      onDowngrade: (info) => this.opts.onModelDowngrade?.(sessionId, info),
      // W855: the SAME per-model modality gate that feeds read_image. It is
      // evaluated against the request's own req.model (inside the decorator),
      // so a model switch is never stale. null (unconfigured) = optimistic:
      // images allowed; only an EXPLICIT list without "image" is text-only.
      isTextOnly: (requestModel) => {
        const modalities = this.opts.modelInputModalities?.(requestModel) ?? null;
        return modalities !== null && !modalities.includes("image");
      },
    }) as unknown as Llm;
  }

  /**
   * W728 §3 P0: wrap the engine `Llm` so every model step books one ledger row
   * (success, failure and retry alike). The wrapper lives in the composed
   * Context, so worker-driven calls go through it as well; the summarizer path
   * is separate (`summarizer()`, a P1 concern).
   */
  private stepObservedLlm(llm: Llm, profile: Profile, ledger: UsageLedger | null): Llm {
    if (ledger === null) return llm;
    return createLedgerLlm({
      inner: llm,
      sink: ledger,
      provider: this.opts.providerLabel ?? null,
      model: profile.model,
      base_url_host: hostOf(profile.base_url),
    });
  }

  /**
   * Base profile + the session's own `session.json` overrides (model AND, since
   * W729, the mode-dependent system prompt; AND, since W2065, the base_url that
   * model was resolved against). This is the ONE place a session's instance
   * profile is decided, so two sessions in the same process can differ in prompt
   * — or in provider — without either one seeing the other's.
   */
  profileFor(sessionId: string | null): Profile {
    const base = this.opts.baseProfile();
    const overrides = this.sessionOverrides(sessionId);
    return overrides === null ? base : { ...base, ...overrides };
  }

  /** The session's profile overrides; `null` when it declares none. */
  private sessionOverrides(sessionId: string | null): Partial<Profile> | null {
    if (sessionId === null) return null;
    const out: Partial<Profile> = {};
    const model = this.opts.sessionModel?.(sessionId) ?? "";
    if (model !== "") out.model = model;
    // W2065: the endpoint travels WITH the model. Without this, a session that
    // pinned another provider's model kept the global base_url and posted that
    // model's id to the old host.
    const baseUrl = this.opts.sessionBaseUrl?.(sessionId) ?? "";
    if (baseUrl !== "") out.base_url = baseUrl;
    const prompt = this.opts.sessionSystemPrompt?.(sessionId) ?? "";
    if (prompt !== "") out.system_prompt = prompt;
    return Object.keys(out).length === 0 ? null : out;
  }

  /** The compact summarizer of the CURRENT base profile. */
  summarizer(): Summarizer {
    const profile = this.opts.baseProfile();
    const factory = this.opts.summarize;
    if (factory !== undefined) return factory(profile);
    return llmSummarizer({ llm: this.llmFactory()(profile), model: profile.model });
  }

  /**
   * Worker wiring: ONE registry per session instance (W513, design D7), so a
   * receipt returns to the session that spawned the worker and `worker:<sid>`
   * ids stay unique through the session-derived prefix. W787: the table is
   * PERSISTED by default at `workerRegistryPath()` (`<data dir>/
   * worker-registry.tsv`; `CELESTEA_WORKER_REGISTRY` overrides). Only an
   * explicit `tsvPath: null` is an in-memory table, so the default no
   * longer collides the host with the fleet's shared `/tmp/registry.tsv`.
   */
  private workerWiring(sessionId: string | null, profile: Profile): WorkerWiring | false {
    if (this.opts.workers === false) return false;
    return {
      tsvPath: this.workerRegistryPath(),
      resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"),
      sourceLabel: "celestea.studio-ts",
      logFactory: (): SessionLog => new InMemorySessionLog(),
      hostSessionId: sessionId ?? "cli-main",
      sessionIdPrefix: workerSessionPrefix(sessionId),
      hostModel: profile.model,
      // W729 §2.3: workers inherit the spawning session's mode by default.
      hostMode: sessionId === null ? null : (this.opts.sessionMode?.(sessionId) ?? null),
    };
  }

  /**
   * agent_swarm wiring (feature §5.3) — `{}` is all the studio needs to pass.
   *
   * The composition root fills the two fields that must NOT be duplicated here:
   * `loopFactory` (the SAME factory the host turn above uses, because a member
   * IS a one-shot turn) and `agentConfig` (derived from this session's profile,
   * so a member inherits the host's model / system prompt / step budget).
   *
   * Why this line exists at all: `ensureSwarmWiring` mounts NOTHING without a
   * wiring object, so omitting it left production with `unknown tool:
   * agent_swarm` — the swarm-live test caught exactly that.
   */
  private swarmWiring(): Record<string, never> {
    // **取消信号由 compose 注入，不必在这里传**（W9290 B1-01）：compose 在本函数之后才
    // 构造 `TurnRunner`，而取消信号是**每个 turn 各自新建**的——此刻这里根本拿不到
    // 「这一轮的信号」，能拿到的只有空壳。所以 compose 用与 questionHolder / runCodeHolder
    // 同一形状的 holder，等 runner 建好后回填 `() => runner.currentSignal`，再以
    // `signalProvider` 的形态交给工具。
    //
    // 修复前这里返回 `{}` 且 compose 也不注入 ⇒ 整条链路**没有任何取消通道**：一个
    // 不配合 abort 的成员会让 `tool.execute` 永久挂住，用户按停止也救不回来
    // （audit3-r2/B1/probe-cancel.ts K1，退出码 7）。
    return {};
  }

  /** E §2.3 P0 ①: the configured table path (see `worker-table.ts` for the rules). */
  private workerRegistryPath(): string | null {
    return workerTablePath({
      env: this.opts.env,
      ...(this.opts.dataDir === undefined ? {} : { dataDir: this.opts.dataDir }),
      resultsDir: this.opts.resultsDir ?? join(process.cwd(), "worker-results"),
      ...(this.opts.workerRegistryPath === undefined ? {} : { override: this.opts.workerRegistryPath }),
    });
  }

  private llmFactory(): (profile: Profile) => Llm {
    return this.opts.llm ?? ((profile: Profile): Llm => createEngineLlm(profile, this.opts.env));
  }

  private bindingTo(sessionId: string | null, dir: string | null): SessionBinding {
    const target = dir === null || sessionId === null ? null : { sessionId, dir };
    return bindingFor(sessionId, target, this.memoryLogs, {
      ...(this.opts.checkpoint ?? {}),
      onDegraded: (info) => this.noteDegraded(info),
    });
  }

  /**
   * E §1.3 P1 ③: a session log that refused a write is reported to the audit
   * channel (the sidecar already carries the sticky counter, §1.2.2). One line
   * per session instance — the store fires this at most once.
   */
  private noteDegraded(info: { session: string; count: number }): void {
    this.opts.recoveryAudit?.write({
      event: "log_degraded",
      session: info.session,
      count: info.count,
      detail: `session log writeErrorCount=${info.count} (disk and memory diverged)`,
    });
  }
}
