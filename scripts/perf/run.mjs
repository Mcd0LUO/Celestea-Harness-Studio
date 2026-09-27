// scripts/perf/run.mjs — 侦测总入口。
//   node scripts/perf/run.mjs q1            # 只跑问题 1
//   node scripts/perf/run.mjs q1 q2 q3 q4   # 按序跑
//   node scripts/perf/run.mjs all
//
// W2021：整个 case 循环包在 try/finally 里，finally 兜一遍**进程收尾**（Chrome / 监听端口 /
// profile）。这一层管的是**异常**路径（某个 case 抛在 boot 与自己的 finally 之间）；**信号**
// 路径（timeout / Ctrl-C / kill）由 lib/cleanup.mjs 的处理器负责 —— Node 在信号下不会跑
// finally，两者互补、缺一不可。
import { closeAllRegistered } from './lib/cleanup.mjs';

/** 四个**测量**场景。默认（无参数）与 `all` 都只跑这四个 —— 口径与改动前逐字一致。 */
const CASES = {
  q1: { file: './cases/q1-think.mjs', run: 'q1' },
  q2: { file: './cases/q2-virtual.mjs', run: 'q2' },
  q3: { file: './cases/q3-mutation.mjs', run: 'q3' },
  q4: { file: './cases/q4-memory.mjs', run: 'q4' },
};
/**
 * 非测量入口：**只给门禁自检用**（tests/w2021-perf-signal-cleanup.test.ts 起真 app 后发信号，
 * 断言端口/Chrome/profile 都被收干净）。刻意**不在**默认列表与 `all` 里 —— 加它不能改变
 * 任何既有调用的行为。
 */
const PROBES = {
  'w2021-signal-stub': { file: './cases/w2021-signal-stub.mjs', run: 'w2021SignalStub' },
};
const DISPATCH = { ...CASES, ...PROBES };

const argv = process.argv.slice(2);
const want = argv.length === 0 || argv.includes('all') ? Object.keys(CASES) : argv.filter((a) => a in DISPATCH);
const out = {};
try {
  for (const name of want) {
    const t0 = Date.now();
    process.stdout.write('=== ' + name + ' ... ');
    try {
      const entry = DISPATCH[name];
      const mod = await import(entry.file);
      out[name] = await mod[entry.run]();
      process.stdout.write('ok (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)\n');
    } catch (err) {
      out[name] = { error: String((err && err.stack) || err) };
      process.stdout.write('FAILED: ' + err + '\n');
    }
  }
} finally {
  // 正常路径下登记表已空（各 case 自己的 finally 关过并注销）⇒ 这里是**无操作**，
  // 不打印、不等待，测量口径不受影响。
  await closeAllRegistered();
}
console.log(JSON.stringify(out, null, 1));
