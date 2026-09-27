// ============================================================================
// scripts/perf/cases/w2021-signal-stub.mjs — **门禁专用探针，不是测量场景**
// ----------------------------------------------------------------------------
// 形状刻意与真实 case 逐字同形（boot → try → 干活 → finally close）：真实 case 就是这样
// 写的，而 **SIGTERM 下 finally 永远不会跑** —— 这正是 W2021 缺陷的现场。门禁向本探针发
// 信号，然后断言「端口可再 bind / 没有孤儿 Chrome / profile 已删」。
// 只有显式点名 `node run.mjs w2021-signal-stub` 才会跑（不在默认列表与 all 里）。
// ============================================================================
import { writeFileSync } from 'node:fs';
import { boot } from '../lib/app.mjs';
import { backendPort, cdpPort } from '../lib/ports.mjs';

export async function w2021SignalStub() {
  const app = await boot({ port: backendPort(), cdpPort: cdpPort() });
  try {
    // 就绪信号：门禁看到这个文件才发信号，避免「信号早于 boot」的竞态。
    writeFileSync(process.env.W2021_READY_FILE, JSON.stringify({
      pid: process.pid, backendPort: backendPort(), cdpPort: cdpPort(), profileDir: app.profileDir,
    }));
    const waitMs = Number(process.env.W2021_WAIT_MS ?? 60000);
    await new Promise((r) => setTimeout(r, waitMs));
    return { closed: false, note: 'signal never arrived' };
  } finally {
    await app.close();
  }
}
