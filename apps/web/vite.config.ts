import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';
import { computeVersion } from '../../scripts/version.mjs';

/**
 * Celestea Studio frontend build.
 * Output: apps/web/dist/{index.html, assets/*.js, assets/*.css, build-meta.json}
 * The backend serves apps/web/dist/ as its static root (shared contract).
 *
 * W887 修正（构建可复现）：构建元数据不再经 define 进 JS bundle —— 墙钟
 * buildTime 进 JS 会让**同一提交**的两次构建字节不同（文件名哈希都变），把
 * 精确字节的产物体积棘轮变成随机门禁。元数据改为在 index.html 里以
 * window.__CELESTEA_BUILD__ 注入（module script 之前的经典脚本）；version.ts
 * 从该全局读，读不到回落。JS/CSS 产物因此只由源码决定（可复现）。
 *
 * W887d（基准确定性）：同一份 BUILD_META 还落盘为 dist/build-meta.json，
 * 作为**构建期真值**。check-version.mjs 只读产物（index.html + build-meta.json +
 * assets），不再调用 computeVersion()/git —— 于是 build→check 之间别的 worker
 * 提交（HEAD 前移）不再误红。
 */
const version = computeVersion();

/** The build metadata the app reads from the DOM (never inlined into JS). */
const BUILD_META = {
  version: version.version,
  commits: version.commitsSinceTag ?? 0,
  sha: version.sha,
  dirty: version.dirty,
  buildTime: version.buildTime,
};

/**
 * W887: inject the metadata as a global in index.html, BEFORE the module script
 * (a classic script runs during parsing; the module script is deferred, so it
 * always sees the global). The payload never enters the JS bundle.
 *
 * W887d: also emit dist/build-meta.json — the build-time truth the gate compares
 * the HTML payload against (so the gate needs no live git).
 */
function buildMetaPlugin(): Plugin {
  const payload = 'window.__CELESTEA_BUILD__ = ' + JSON.stringify(BUILD_META) + ';';
  const truth = JSON.stringify(BUILD_META, null, 2) + '\n';
  return {
    name: 'celestea-build-meta',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => ({
        html,
        tags: [{ tag: 'script', children: payload, injectTo: 'head-prepend' }],
      }),
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'build-meta.json', source: truth });
    },
  };
}

/**
 * `@celestea/gesture` 打到**源码**（packages/gesture/src/index.ts），不走包入口的 dist。
 *
 * 为什么必须这样：`check:web` → `scripts/build-webdist.mjs` 只跑 `pnpm --dir apps/web
 * run build`，它**不会先构建 packages/**。走 dist 的话，前端打进浏览器包的就是上一次
 * `pnpm -r build` 的产物 —— 本机 dist 常年存在，这个洞只会在别人的干净机器/CI 上现形
 * （正是 AGENT.md §8「本机能跑 ≠ 干净机器能跑」那条）。gesture 是零依赖纯函数叶子包，
 * 让 Vite 直接编译源码没有任何代价。
 *
 * ★ **两侧成对**：`apps/web/tsconfig.json` 的 `paths` 指同一个文件，`typecheck:web`
 * 才能 typecheck 到同一份源码。少任何一侧都会出现「构建过了但类型没查」或反之。
 */
const CELESTEA_ALIASES = {
  '@celestea/gesture': fileURLToPath(
    new URL('../../packages/gesture/src/index.ts', import.meta.url),
  ),
};

export default defineConfig({
  plugins: [buildMetaPlugin()],
  base: '/',
  resolve: { alias: CELESTEA_ALIASES },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
