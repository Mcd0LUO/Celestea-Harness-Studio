#!/usr/bin/env node
/**
 * Verify a bsdiff patch by APPLYING it and comparing bytes — before publishing it.
 *
 * The updater docs say it plainly ("Test patches against a real install"): a patch
 * that applies cleanly but produces a non-bootable library only reveals itself as
 * a failed launch on a user's machine, followed by a rollback. This script makes
 * that checkable in CI, without a `deno desktop` build and without a bsdiff reader
 * on the host:
 *
 *   node desktop/scripts/verify-patch.mjs \
 *     --old dist/v1/CelesteaStudio/CelesteaStudio.so \
 *     --patch release/linux-x64/patch-2.8.1-to-2.8.2.bin \
 *     --expect dist/v2/CelesteaStudio/CelesteaStudio.so
 *
 * It is an INDEPENDENT implementation of the bsdiff 4.x reader (control/diff/extra
 * triples, sign-magnitude `off_t`, three bzip2 streams) — deliberately not shared
 * with the writer in `make-release.mjs`, so a disagreement between the two is
 * caught rather than self-confirmed. The output is written next to the patch as
 * `<patch>.applied` for inspection.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--old") options.old = value();
    else if (arg === "--patch") options.patch = value();
    else if (arg === "--expect") options.expect = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return options;
}

/** Read bsdiff's sign-magnitude `off_t` (7 magnitude bytes + a sign bit). */
export function readOffT(buffer, offset) {
  let magnitude = 0n;
  for (let i = 7; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(buffer[offset + i] & (i === 7 ? 0x7f : 0xff));
  const signed = (buffer[offset + 7] & 0x80) === 0 ? magnitude : -magnitude;
  return Number(signed);
}

/** Decompress one bzip2 stream through the system tool. */
function bunzip2(bytes) {
  try {
    return execFileSync("bzip2", ["-dc"], { input: bytes, maxBuffer: 2 ** 31 });
  } catch (error) {
    throw new Error(`bzip2 -dc failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
}

/** Apply a bsdiff 4.x patch; returns the reconstructed bytes. */
export function applyBsdiff(oldBytes, patchBytes) {
  if (patchBytes.subarray(0, 8).toString("ascii") !== "BSDIFF40") {
    throw new Error("not a bsdiff patch (missing BSDIFF40 magic)");
  }
  const controlLength = readOffT(patchBytes, 8);
  const diffLength = readOffT(patchBytes, 16);
  const newSize = readOffT(patchBytes, 24);
  const controlStart = 32;
  const diffStart = controlStart + controlLength;
  const extraStart = diffStart + diffLength;
  const control = bunzip2(patchBytes.subarray(controlStart, diffStart));
  const diff = bunzip2(patchBytes.subarray(diffStart, extraStart));
  const extra = bunzip2(patchBytes.subarray(extraStart));

  const output = Buffer.alloc(newSize);
  let oldPos = 0;
  let controlPos = 0;
  let diffPos = 0;
  let extraPos = 0;
  for (let newPos = 0; newPos < newSize; ) {
    if (controlPos + 24 > control.length) throw new Error("control stream ran out before the output was complete");
    const addLength = readOffT(control, controlPos);
    const copyLength = readOffT(control, controlPos + 8);
    const seekLength = readOffT(control, controlPos + 16);
    controlPos += 24;
    if (newPos + addLength > newSize || diffPos + addLength > diff.length) throw new Error("diff stream overruns the output");
    for (let i = 0; i < addLength; i++) {
      const oldByte = oldPos + i < oldBytes.length ? oldBytes[oldPos + i] : 0;
      output[newPos + i] = (diff[diffPos + i] + oldByte) & 0xff;
    }
    newPos += addLength;
    diffPos += addLength;
    oldPos += addLength;
    if (newPos + copyLength > newSize || extraPos + copyLength > extra.length) throw new Error("extra stream overruns the output");
    extra.copy(output, newPos, extraPos, extraPos + copyLength);
    newPos += copyLength;
    extraPos += copyLength;
    oldPos += seekLength;
  }
  return output;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.old || !options.patch) {
    console.log(`Apply a bsdiff patch and compare it with the expected bytes.

  node desktop/scripts/verify-patch.mjs --old <library> --patch <patch.bin> [--expect <library>] [--out <file>]`);
    return options.help ? 0 : 1;
  }
  const oldBytes = readFileSync(options.old);
  const patchBytes = readFileSync(options.patch);
  const applied = applyBsdiff(oldBytes, patchBytes);
  const out = options.out ?? `${options.patch}.applied`;
  writeFileSync(out, applied);
  console.log(`[verify-patch] ${basename(options.patch)}: ${oldBytes.length} + patch -> ${applied.length} bytes`);
  console.log(`[verify-patch] applied output: ${out} (sha256 ${sha256(applied).slice(0, 16)}…)`);
  if (options.expect === undefined) return 0;
  const expected = readFileSync(options.expect);
  if (applied.length !== expected.length) {
    console.error(`[verify-patch] MISMATCH: length ${applied.length} != expected ${expected.length}`);
    return 1;
  }
  if (sha256(applied) !== sha256(expected)) {
    console.error(`[verify-patch] MISMATCH: ${sha256(applied)} != ${sha256(expected)}`);
    return 1;
  }
  console.log(`[verify-patch] OK: the patched library is byte-identical to ${basename(options.expect)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[verify-patch] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
