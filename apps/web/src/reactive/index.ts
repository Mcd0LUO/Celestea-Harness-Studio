// reactive 模块的公开面（只暴露原语，不暴露内部 EffectNode/Source）。
export { signal, computed, effect, batch, untrack, onCleanup } from './signal';
export type { Signal, ReadonlySignal } from './signal';
