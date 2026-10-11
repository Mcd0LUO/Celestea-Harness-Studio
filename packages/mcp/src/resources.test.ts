/**
 * Disposal scopes (resources.ts): reverse order, idempotence, and "a failing
 * teardown never skips the rest".
 */

import { describe, expect, it } from "vitest";

import { createDisposableScope } from "./resources.js";

describe("createDisposableScope", () => {
  it("releases in reverse acquisition order", async () => {
    const order: string[] = [];
    const scope = createDisposableScope();
    scope.add(() => {
      order.push("a");
    });
    scope.add(() => {
      order.push("b");
    });
    scope.add(() => {
      order.push("c");
    });
    await scope.dispose();
    expect(order).toEqual(["c", "b", "a"]);
  });

  it("is idempotent: a second dispose releases nothing twice", async () => {
    let count = 0;
    const scope = createDisposableScope();
    scope.add(() => {
      count++;
    });
    await scope.dispose();
    await scope.dispose();
    expect(count).toBe(1);
    expect(scope.isDisposed).toBe(true);
  });

  it("keeps releasing after one disposer throws, and reports the error", async () => {
    const errors: unknown[] = [];
    const order: string[] = [];
    const scope = createDisposableScope({ onError: (e) => errors.push(e) });
    scope.add(() => {
      order.push("first");
    });
    scope.add(() => {
      throw new Error("child survived");
    });
    await scope.dispose();
    expect(order).toEqual(["first"]);
    expect(errors).toHaveLength(1);
  });

  it("awaits an async disposer before returning", async () => {
    let done = false;
    const scope = createDisposableScope();
    scope.add(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done = true;
    });
    await scope.dispose();
    expect(done).toBe(true);
  });

  it("disposes immediately what is registered after disposal started", async () => {
    const scope = createDisposableScope();
    await scope.dispose();
    let released = false;
    scope.add(() => {
      released = true;
    });
    expect(released).toBe(true);
  });
});
