#!/usr/bin/env node
/**
 * Two macOS build tools, reimplemented so a Linux host can finish a `.app`.
 *
 * WHY. `deno desktop` cross-compiles the macOS *binary* anywhere, but assembling
 * the `.app` bundle shells out to two macOS-only programs, and the failure is a
 * bare `error: No such file or directory (os error 2)` after the dylib is built:
 *
 *   1. `iconutil -c icns <iconset> -o <out.icns>` — called whenever the bundle
 *      carries an icon (measured: it runs even when `desktop.app.icons.macos`
 *      points at a prebuilt `.icns`, so it cannot be avoided from deno.json).
 *   2. `codesign --sign - …` — ad-hoc signing. Deno's own error text names it:
 *      "codesigning requires a macOS build host (uses codesign(1))".
 *
 * What this file provides:
 *   - `iconutil`: the `.iconset` → `.icns` container conversion, in pure Node.
 *     An `.icns` is a header plus `(type, length, PNG bytes)` entries, and the
 *     iconset already holds the PNGs — no image processing is involved, which is
 *     why this is ~80 lines instead of a rasterizer.
 *   - `codesign`: a no-op that reports success, i.e. the bundle stays UNSIGNED.
 *
 * THE HONEST CONSEQUENCE (why this is opt-in, never automatic):
 *   An unsigned `.app` is refused by Gatekeeper on first launch. The user has to
 *   clear the quarantine flag once (`xattr -dr com.apple.quarantine "Celestea
 *   Studio.app"`) or right-click → Open. A signed+notarized build still requires a
 *   Mac (or CI with a macOS runner — see .github/workflows/desktop-release.yml).
 *   One upside of an unsigned bundle: the auto-updater patches the dylib inside
 *   it, which invalidates a real code signature — with no signature there is
 *   nothing to invalidate.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-PNG name → ICNS type code, for the app icon Deno reads from
 * `desktop.app.icons.macos`.
 *
 * The official config schema types that field as a STRING (".icns or .png"), so a
 * single `.icns` file is what this project points at — even though the prose docs
 * show an array of `{path,size}` objects. The runtime tolerates the array, but the
 * schema is what editors validate against, and a config that shows as invalid is a
 * config that will bite someone later.
 */
export const APP_ICNS_TYPES = [
  { name: "icon-128.png", type: "ic07" },
  { name: "icon-256.png", type: "ic08" },
  { name: "icon-512.png", type: "ic09" },
  { name: "icon-64.png", type: "ic12" },
  { name: "icon-16.png", type: "icp4" },
  { name: "icon-32.png", type: "icp5" },
];

/**
 * iconset file name → ICNS type code.
 *
 * Only the PNG-capable, modern types are emitted (macOS scales downward from
 * them). The legacy 16/32 px types (`icp4`/`icp5`) are deliberately skipped: they
 * are the ones whose payload format varies across macOS versions, and omitting
 * them is what most `.icns` files in the wild do.
 */
export const ICNS_TYPES = {
  "icon_128x128.png": "ic07",
  "icon_256x256.png": "ic08",
  "icon_512x512.png": "ic09",
  "icon_1024x1024.png": "ic10",
  "icon_32x32@2x.png": "ic11",
  "icon_64x64.png": "ic12",
  "icon_128x128@2x.png": "ic13",
  "icon_256x256@2x.png": "ic14",
  "icon_512x512@2x.png": "ic15",
};

/** Pack an `.iconset` directory into `.icns` bytes. */
export function packIcns(iconsetDir) {
  const entries = [];
  for (const name of readdirSync(iconsetDir).sort()) {
    const type = ICNS_TYPES[name];
    if (type === undefined) continue; // 16/32 px and anything unexpected
    const png = readFileSync(join(iconsetDir, name));
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    entries.push(Buffer.concat([header, png]));
  }
  if (entries.length === 0) throw new Error(`no usable PNGs in ${iconsetDir}`);
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/** Pack `icons/icon-<size>.png` into a multi-resolution `icons/app.icns`. */
export function writeAppIcns(iconsDir, outFile) {
  const entries = [];
  for (const { name, type } of APP_ICNS_TYPES) {
    const file = join(iconsDir, name);
    if (!existsSync(file)) continue;
    const png = readFileSync(file);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    entries.push(Buffer.concat([header, png]));
  }
  if (entries.length === 0) throw new Error(`no icon-*.png found in ${iconsDir}`);
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  writeFileSync(outFile, Buffer.concat([header, body]));
  return { outFile, reps: entries.length, bytes: body.length + 8 };
}

/** List the (type, length) entries of an `.icns`, for verification. */
export function readIcnsEntries(buf) {
  const out = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const type = buf.toString("ascii", offset, offset + 4);
    const length = buf.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buf.length) break;
    out.push({ type, length });
    offset += length;
  }
  return out;
}

/** The `iconutil` shim source: `iconutil -c icns <iconset> -o <out>`. */
function iconutilSource(modulePath) {
  return `#!/usr/bin/env node
// Generated by desktop/scripts/macos-unsigned-tools.mjs — the macOS tool
// "iconutil", reimplemented for a non-macOS build host (see that file).
const { packIcns } = await import(${JSON.stringify(modulePath)});
const args = process.argv.slice(2);
const take = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const out = take("-o");
const iconset = args.find((a) => !a.startsWith("-") && a.endsWith(".iconset"));
if (out === null || iconset === undefined) {
  console.error("iconutil (shim): usage: iconutil -c icns <iconset> -o <out.icns>");
  process.exit(2);
}
const { writeFileSync } = await import("node:fs");
writeFileSync(out, packIcns(iconset));
`;
}

function codesignSource() {
  return `#!/usr/bin/env node
// Generated by desktop/scripts/macos-unsigned-tools.mjs — a no-op stand-in for
// macOS "codesign": the bundle is produced UNSIGNED on purpose (see that file for
// the consequences and how to open such an app).
process.exit(0);
`;
}

/**
 * Materialise the shims and return the directory to prepend to `PATH`.
 *
 * They are written next to the build output (not in /tmp) so a failed build leaves
 * the tools around to inspect, and they are regenerated on every build so a fix in
 * this file always takes effect.
 */
export function installUnsignedMacosTools(dir, modulePath = import.meta.filename) {
  mkdirSync(dir, { recursive: true });
  const iconutil = join(dir, "iconutil");
  const codesign = join(dir, "codesign");
  writeFileSync(iconutil, iconutilSource(modulePath));
  writeFileSync(codesign, codesignSource());
  chmodSync(iconutil, 0o755);
  chmodSync(codesign, 0o755);
  return dir;
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  const [first, second] = process.argv.slice(2);
  if (first === "--app-icns" && second !== undefined) {
    // `--app-icns <iconsDir> <outFile>` — the app icon Deno reads, packed from the
    // committed PNGs (and regenerated by build.mjs whenever they change).
    const outFile = process.argv[4] ?? join(second, "app.icns");
    const result = writeAppIcns(second, outFile);
    console.log(`[icons] ${outFile}: ${result.reps} representations, ${result.bytes} bytes`);
    process.exit(0);
  }
  if (first === undefined) {
    console.error("usage: node desktop/scripts/macos-unsigned-tools.mjs <shim-dir>");
    console.error("       node desktop/scripts/macos-unsigned-tools.mjs --app-icns <iconsDir> [outFile]");
    process.exit(2);
  }
  console.log(`[macos-unsigned] shims written to ${installUnsignedMacosTools(first)}`);
}
