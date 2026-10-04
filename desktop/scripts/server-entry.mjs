/**
 * The single entry esbuild bundles into `app/celestea-server.mjs`.
 *
 * Everything the desktop shell needs from the product passes through here, and
 * nothing else does — this file IS the shell's contract with the studio, which is
 * why `desktop/src/studio-api.ts` validates all five exports at load time.
 *
 * Notes for whoever edits this list:
 *   - the studio's compiled output (`dist/`) is used, NOT the TypeScript sources:
 *     those import each other with `.js` specifiers that only a tsc/NodeNext
 *     resolver understands, and the shipped artifacts are the thing users run;
 *   - `open-browser.ts` is imported from source on purpose, because it lives in
 *     the CLI package and is not part of the studio's build output. It imports
 *     only `node:` builtins and `@celestea/tools`, so esbuild compiles it inline
 *     and the desktop app opens a browser exactly the way `celestea web` does.
 */

export { startStudioServer } from "../../apps/studio/dist/server.js";
export { loadStudioConfig } from "../../apps/studio/dist/config.js";
export { verifyContractsAtStartup, celesteaHome } from "../../packages/core/dist/index.js";
export { openBrowser } from "../../apps/cli/src/open-browser.ts";
