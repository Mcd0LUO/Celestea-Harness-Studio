/**
 * EX-03 —— verify-contracts.ts 的运行期参数（探测目标 + 超时）。
 *
 * 纯搬家：解析时机仍在模块求值期（早于 main()），因此 --studio / --timeout-ms
 * 的生效时机与拆分前完全一致。
 */
import { num, parseArgs, str } from "../lib/args.js";

const args = parseArgs(process.argv.slice(2));

export const STUDIO = str(args, "studio", "http://127.0.0.1:3777");
export const TIMEOUT = num(args, "timeout-ms", 10_000);
