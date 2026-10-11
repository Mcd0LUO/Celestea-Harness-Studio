/**
 * Disposal scopes — the `ctx.effect` discipline, expressed where this repository
 * can actually enforce it.
 *
 * The upstream MCP client hangs every resource off `ctx.effect(() => …)`, so the
 * plugin lifecycle owns teardown and nothing outlives the generation. This
 * repository's `Context` (packages/core/src/context.ts) has provide/get/scoped and
 * no effect slot, so the same discipline is implemented here as an explicit scope
 * and will be bound to the Context by the assembly wave. What matters now is the
 * SHAPE, because it is the shape that is wrong when forgotten:
 *
 *   - resources are released in REVERSE acquisition order;
 *   - `dispose()` is idempotent and never throws (a failed teardown is reported,
 *     not propagated — one dead child process must not abort the remaining
 *     teardown steps);
 *   - everything registered is released, including resources registered AFTER
 *     disposal started (they are disposed immediately).
 */

/** One release step. Sync or async; errors are reported, never thrown. */
export type Disposer = () => void | Promise<void>;

export interface DisposableScope {
  readonly isDisposed: boolean;
  /** Register a disposer. Registering after disposal disposes at once. */
  add(disposer: Disposer): void;
  /** Release everything, in reverse order. Idempotent. */
  dispose(): Promise<void>;
}

export interface DisposableScopeOptions {
  /** Where teardown failures go. Default: swallow (teardown must not throw). */
  readonly onError?: (error: unknown) => void;
}

export function createDisposableScope(options: DisposableScopeOptions = {}): DisposableScope {
  const disposers: Disposer[] = [];
  let disposed = false;
  let running: Promise<void> | null = null;

  async function release(): Promise<void> {
    while (disposers.length > 0) {
      const disposer = disposers.pop();
      if (disposer === undefined) continue;
      try {
        await disposer();
      } catch (error) {
        options.onError?.(error);
      }
    }
  }

  return {
    get isDisposed(): boolean {
      return disposed;
    },
    add(disposer: Disposer): void {
      if (disposed) {
        void Promise.resolve(disposer()).catch((error: unknown) => options.onError?.(error));
        return;
      }
      disposers.push(disposer);
    },
    dispose(): Promise<void> {
      if (running === null) {
        disposed = true;
        running = release();
      }
      return running;
    },
  };
}
