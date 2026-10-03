#!/usr/bin/env node
/**
 * Generate the Ed25519 keypair that signs release manifests.
 *
 * Why sign at all, when every patch already carries a SHA-256 in the manifest:
 * the hash stops a corrupted download, not a hostile release host. Whoever can
 * serve `latest.json` can serve a correctly-hashed malicious patch. With
 * `publicKey` configured, `Deno.autoUpdate()` verifies an Ed25519 signature over
 * the manifest's `signed` string before trusting any of it, and the private key
 * never has to live on the release host.
 *
 *   node desktop/scripts/gen-update-key.mjs --out tmp/update-key
 *
 * Writes `<out>/private.pem` (mode 0600, KEEP OFFLINE) and prints the base64 raw
 * public key to hand to the app: stage it as `desktop/update-pubkey.txt`, or set
 * `CELESTEA_DESKTOP_UPDATE_PUBKEY`. Publish the public key; never the private one.
 */

import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const options = { out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.out = argv[++i];
    else if (arg === "--force") options.force = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return options;
}

/**
 * The base64 raw (32-byte) public key the runtime expects — the last 32 bytes of
 * the SPKI DER, which is where Ed25519 puts its public point.
 *
 * Accepts a public KeyObject, or a private one (it derives the public half).
 * Do NOT wrap a public KeyObject in `createPublicKey()` first: on Node 24 that
 * throws `Invalid key object type public, expected private` for Ed25519 — which
 * is exactly how the first version of this script failed.
 */
export function rawPublicKeyBase64(key) {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  const der = publicKey.export({ type: "spki", format: "der" });
  if (der.length < 32) throw new Error(`unexpected SPKI length ${der.length} for an Ed25519 key`);
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.out === null) {
    console.log(`Generate an Ed25519 signing keypair for desktop release manifests.

  node desktop/scripts/gen-update-key.mjs --out <dir> [--force]

Writes <dir>/private.pem (0600) and <dir>/public.txt (base64 raw public key).`);
    return options.help ? 0 : 1;
  }
  const dir = options.out;
  const privatePath = join(dir, "private.pem");
  if (existsSync(privatePath) && !options.force) {
    throw new Error(`${privatePath} already exists — pass --force to overwrite (that invalidates shipped manifests)`);
  }
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  writeFileSync(privatePath, pem);
  chmodSync(privatePath, 0o600);
  const base64 = rawPublicKeyBase64(publicKey);
  writeFileSync(join(dir, "public.txt"), `${base64}\n`);
  console.log(`[update-key] private key: ${privatePath} (0600 — keep it offline)`);
  console.log(`[update-key] public key:  ${base64}`);
  console.log(`[update-key] give it to the app with either:`);
  console.log(`[update-key]   echo '${base64}' > desktop/update-pubkey.txt     (staged into the build)`);
  console.log(`[update-key]   CELESTEA_DESKTOP_UPDATE_PUBKEY='${base64}'        (runtime override)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[update-key] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
