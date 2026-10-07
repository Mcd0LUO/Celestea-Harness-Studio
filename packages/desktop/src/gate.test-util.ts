// @vitest-environment node
/**
 * M2 闸门的**测试夹具**（不是产品代码：tsconfig.build.json 排除了 `*.test-util.ts`）。
 *
 * 为什么单独一个文件：闸门的用例分两片 —— 十态真值表（gate.test.ts）与审查修复的
 * 应用标识/标题用例（gate-apps.test.ts）—— 两片共用同一套夹具，而 `max-lines` 的
 * 450 行预算不允许把它们塞回一个文件。夹具只在这里定义一次，两片都从这里取。
 *
 * 全部是**假授权源 + 假确认通道**（它们是 gate.ts 声明的结构化端口，属于外部边界），
 * 不碰真桌面、不跑真机、不起 helper —— 闸门是纯判定，所以它就该能被这样钉死。
 */
import { createDesktopGate, type DesktopConfirmChannel, type DesktopConfirmOutcome, type DesktopConfirmRequest, type DesktopDeadline, type DesktopGate, type DesktopGateGrant, type DesktopGateGrantSource, type DesktopGateVerdict, type DesktopTitleResolver } from "./gate.js";
import { expect } from "vitest";

/** 一个只按脚本回答的授权源（每次 read 现取，所以测试能中途改授权）。 */
export function grantsOf(initial: DesktopGateGrant): { source: DesktopGateGrantSource; set: (next: DesktopGateGrant) => void } {
  let current = initial;
  return { source: { read: () => current }, set: (next) => (current = next) };
}

/** 一个按脚本回答的确认通道；记下每一次请求，便于断言「闸门把什么交给了人」。 */
export function channelOf(answer: (request: DesktopConfirmRequest) => Promise<DesktopConfirmOutcome> | DesktopConfirmOutcome): {
  channel: DesktopConfirmChannel;
  seen: DesktopConfirmRequest[];
} {
  const seen: DesktopConfirmRequest[] = [];
  return {
    seen,
    channel: {
      confirm: (request) => {
        seen.push(request);
        return Promise.resolve(answer(request));
      },
    },
  };
}

export const NOTEPAD = { window: { app: "notepad.exe", id: 7 } };
export const granted: DesktopGateGrant = { desktop: true };

/**
 * 测试用的超时原语（W2014）。
 *
 * 生产实现是 `packages/tools` 的 `bounded`，由宿主注入；而 `packages/desktop` 只依赖
 * `core`，**测试也解析不到 tools** —— 所以这里写一份最小实现。棘轮的口径是「整行含
 * test 即排除」（它拦的是产品代码里的各自为政），测试本就允许自己造竞态；而这里要验的
 * 是**闸门怎么用这个端口**：超时到了它算什么、通道不守约时会不会挂死。原语自身的语义
 * （三种策略、计时器清理、迟到的 rejection）由 tools 侧自己的测试钉住。
 */
export const testDeadline: DesktopDeadline = (work, timeoutMs, onTimeout) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), Math.max(0, timeoutMs));
    timer.unref?.();
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });

/** 夹具的可选覆盖项。 */
export interface GateOverrides {
  grants?: DesktopGateGrant;
  answer?: (request: DesktopConfirmRequest) => Promise<DesktopConfirmOutcome> | DesktopConfirmOutcome;
  channel?: DesktopConfirmChannel | null;
  limiter?: Parameters<typeof createDesktopGate>[0]["limiter"];
  timeoutMs?: number;
  now?: () => number;
  platform?: string;
  /** 覆盖超时原语（用于证明端口真的被用上）。 */
  deadline?: DesktopDeadline;
  /** 真实标题的解析器（titles 清单非空时判定必须用它）。 */
  titleResolver?: DesktopTitleResolver;
}

/**
 * 一个「授权齐备、通道说批准」的基准闸门（各用例只覆盖自己关心的那一维）。
 *
 * `answer` 是「人怎么答」的脚本，`seen` 永远取自**闸门真正用过的那条通道**；
 * `channel` 只给三种特殊通道用（永不 settle / 抛错 / 缺席），那三种下 `seen` 为空。
 */
export function gateWith(over: GateOverrides = {}): { gate: DesktopGate; set: (next: DesktopGateGrant) => void; seen: DesktopConfirmRequest[] } {
  const store = grantsOf(over.grants ?? granted);
  const c = over.channel === undefined ? channelOf(over.answer ?? (() => "approve")) : { channel: over.channel, seen: [] as DesktopConfirmRequest[] };
  const gate = createDesktopGate({
    grants: store.source,
    confirm: c.channel,
    deadline: over.deadline ?? testDeadline,
    platform: over.platform ?? "win32",
    ...(over.titleResolver === undefined ? {} : { titleResolver: over.titleResolver }),
    ...(over.limiter === undefined ? {} : { limiter: over.limiter }),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
    ...(over.now === undefined ? {} : { now: over.now }),
  });
  return { gate, set: store.set, seen: c.seen };
}

/** 断言「这是一次拒绝」并取出原因码与理由。 */
export const denied = (verdict: DesktopGateVerdict): { code: string; reason: string } => {
  expect(verdict.kind).toBe("deny");
  return verdict as { code: string; reason: string };
};
