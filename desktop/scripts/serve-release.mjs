#!/usr/bin/env node
/**
 * A local HTTPS static server for TESTING the auto-updater end to end.
 *
 * `Deno.autoUpdate()` refuses to poll a plaintext endpoint ("The update URL must
 * be https://"), so verifying the update flow needs a TLS origin. This script
 * serves a release directory (`latest.json` + patches) over HTTPS on loopback,
 * generating a self-signed certificate when asked.
 *
 * The certificate it generates is a self-signed CA+leaf for `localhost` and
 * `127.0.0.1`. Point the app at it the supported way — bake the CA into the test
 * build:
 *
 *   node desktop/scripts/serve-release.mjs --dir release/linux-x64 --generate-cert tmp/release-tls
 *   node desktop/scripts/build.mjs --skip-repo-build \
 *        --deno-flag --cert --deno-flag tmp/release-tls/cert.pem
 *
 * This is a test harness for one machine, not a release server: it binds
 * loopback, speaks no HTTP/2, and logs every request on purpose (you should SEE
 * the runtime fetch `latest.json` and then the patch).
 */

import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

function parseArgs(argv) {
  const options = { dir: null, port: 8443, host: "127.0.0.1", cert: null, key: null, generateCert: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--dir") options.dir = value();
    else if (arg === "--port") options.port = Number.parseInt(value(), 10);
    else if (arg === "--host") options.host = value();
    else if (arg === "--cert") options.cert = value();
    else if (arg === "--key") options.key = value();
    else if (arg === "--generate-cert") options.generateCert = value();
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  return options;
}

export const CONTENT_TYPES = {
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Create a two-level PKI for loopback testing: a CA and a leaf.
 *
 * Why not one self-signed certificate: a certificate carrying
 * `basicConstraints=CA:TRUE` cannot be used as a server certificate — rustls
 * (Deno's TLS stack) rejects it with `CaUsedAsEndEntity`, which is exactly how the
 * first version of this harness failed. So a CA is generated once and the server
 * leaf is signed by it; the app is built with `--cert=<dir>/ca.pem` (the CA only),
 * the same shape a private PKI would have in production.
 *
 * Returns the CA path separately, because that is the file that gets BAKED INTO
 * the test build.
 */
export function generateCertificate(dir) {
  mkdirSync(dir, { recursive: true });
  const ca = join(dir, "ca.pem");
  const caKey = join(dir, "ca-key.pem");
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  if (existsSync(ca) && existsSync(caKey) && existsSync(cert) && existsSync(key)) {
    return { ca, cert, key, reused: true };
  }
  const quiet = { stdio: "pipe" };
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", caKey, "-out", ca,
    "-days", "3650",
    "-subj", "/CN=Celestea Release Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], quiet);
  const csr = join(dir, "server.csr");
  const ext = join(dir, "server.ext");
  execFileSync("openssl", [
    "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", key, "-out", csr,
    "-subj", "/CN=localhost",
  ], quiet);
  writeFileSync(ext, [
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n"));
  execFileSync("openssl", [
    "x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial",
    "-out", cert, "-days", "30", "-extfile", ext,
  ], quiet);
  return { ca, cert, key, reused: false };
}

/** Resolve a request path inside the served directory, or null when it escapes. */
export function resolveWithin(root, urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^([/\\])+/, "");
  const full = resolve(root, clean === "" ? "latest.json" : clean);
  const base = resolve(root) + sep;
  return full.startsWith(base) || full === resolve(root) ? full : null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Serve a release directory over HTTPS for testing the updater.

  node desktop/scripts/serve-release.mjs --dir <release-dir> [--port 8443]
                                        [--cert cert.pem --key key.pem]
                                        [--generate-cert <dir>]
                                        [--host 127.0.0.1] [--quiet]

  --generate-cert writes a CA (ca.pem) and a leaf signed by it (cert.pem/key.pem).
  The app trusts the CA: --deno-flag "--cert=<dir>/ca.pem".`);
    return 0;
  }
  if (options.dir === null) throw new Error("--dir is required");
  const root = resolve(options.dir);
  if (!existsSync(root)) throw new Error(`no such directory: ${root}`);

  let cert = options.cert;
  let key = options.key;
  if (options.generateCert !== null) {
    const generated = generateCertificate(options.generateCert);
    cert = cert ?? generated.cert;
    key = key ?? generated.key;
    console.log(`[release-server] PKI ${generated.reused ? "reused" : "generated"}: leaf ${generated.cert}`);
    console.log(`[release-server] bake the CA into a test build: --deno-flag "--cert=${generated.ca}"`);
  }
  if (cert === null || key === null) throw new Error("--cert and --key are required (or use --generate-cert)");

  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (request, response) => {
    const target = resolveWithin(root, request.url ?? "/");
    console.log(`[release-server] ${request.method} ${request.url} ua=${request.headers["user-agent"] ?? "-"}`);
    if (target === null || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = readFileSync(target);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
  });

  server.listen(options.port, options.host, () => {
    console.log(`[release-server] serving ${root} at https://${options.host}:${options.port}/`);
    console.log(`[release-server] point a test build at it: CELESTEA_DESKTOP_UPDATE_URL=https://${options.host}:${options.port}`);
  });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[release-server] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
