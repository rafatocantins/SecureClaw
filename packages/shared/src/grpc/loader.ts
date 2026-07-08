/**
 * loader.ts — Runtime proto loader and mTLS credential helpers for gRPC services.
 *
 * Loads .proto files from the shared package's source tree at runtime.
 * No protoc required — @grpc/proto-loader handles everything.
 *
 * mTLS credential loading:
 *   - serverCredentials(serviceName) — for gRPC servers
 *   - clientCredentials(clientName)  — for gRPC clients
 *
 * Cert discovery (env vars):
 *   GRPC_CERTS_DIR  — directory containing {name}.crt, {name}.key, ca.crt
 *                     (default: ./certs relative to cwd)
 *   GRPC_TLS        — set to "required" to fail hard when certs are missing
 *                     (default: falls back to insecure transport with a warning)
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

const _require = createRequire(import.meta.url);

function getProtoDir(): string {
  // Resolve the shared package's root from its package.json
  const sharedPkgJson = _require.resolve("@tessera/shared/package.json");
  return path.join(path.dirname(sharedPkgJson), "src", "proto");
}

const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

/**
 * Load a .proto file and return the gRPC package definition.
 * The result is cast to `any` so callers can extract their specific service.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadProto(protoFile: string): any {
  const protoDir = getProtoDir();
  const protoPath = path.join(protoDir, protoFile);

  const packageDef = protoLoader.loadSync(protoPath, {
    ...LOADER_OPTIONS,
    includeDirs: [protoDir],
  });

  return grpc.loadPackageDefinition(packageDef);
}

export { grpc };

// ── mTLS credential helpers ────────────────────────────────────────────────

function getCertsDir(): string {
  return process.env["GRPC_CERTS_DIR"] ?? "./certs";
}

function isTlsRequired(): boolean {
  return process.env["GRPC_TLS"] === "required";
}

function warnInsecure(role: string, name: string, dir: string): void {
  process.stderr.write(
    `[grpc-tls] No certs for ${role} '${name}' in '${dir}' — using insecure transport. ` +
    `Run scripts/gen-certs.sh and set GRPC_CERTS_DIR to enable mTLS.\n`
  );
}

/**
 * Load mTLS server credentials for a named service.
 *
 * @param serviceName — matches the filename stem in GRPC_CERTS_DIR
 *                      (e.g. "agent-runtime" → agent-runtime.crt / agent-runtime.key)
 *
 * Returns SSL credentials with mutual TLS (client cert required).
 * Falls back to insecure() when cert files are absent, unless GRPC_TLS=required.
 */
export function serverCredentials(serviceName: string): grpc.ServerCredentials {
  const dir = getCertsDir();
  const caCertPath = path.join(dir, "ca.crt");
  const certPath = path.join(dir, `${serviceName}.crt`);
  const keyPath = path.join(dir, `${serviceName}.key`);

  if (!existsSync(caCertPath) || !existsSync(certPath) || !existsSync(keyPath)) {
    if (isTlsRequired()) {
      throw new Error(
        `[grpc-tls] GRPC_TLS=required but certs missing for server '${serviceName}' in '${dir}'. ` +
        `Run: bash scripts/gen-certs.sh`
      );
    }
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        `[grpc-tls] mTLS certs missing for server '${serviceName}' in '${dir}' and NODE_ENV=production. ` +
        `Run: bash scripts/gen-certs.sh and set GRPC_CERTS_DIR`
      );
    }
    warnInsecure("server", serviceName, dir);
    return grpc.ServerCredentials.createInsecure();
  }

  const caCert = readFileSync(caCertPath);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);

  process.stderr.write(`[grpc-tls] mTLS enabled for server '${serviceName}'\n`);
  // requireClientCert = true enforces mutual TLS
  return grpc.ServerCredentials.createSsl(
    caCert,
    [{ cert_chain: cert, private_key: key }],
    true
  );
}

/**
 * Load mTLS client credentials for a named client service.
 *
 * @param clientName — the name of the calling service (e.g. "gateway", "agent-runtime")
 *                     used to load the client's own cert for mutual authentication.
 *
 * Falls back to insecure() when cert files are absent, unless GRPC_TLS=required.
 */
export function clientCredentials(clientName: string): grpc.ChannelCredentials {
  const dir = getCertsDir();
  const caCertPath = path.join(dir, "ca.crt");
  const certPath = path.join(dir, `${clientName}.crt`);
  const keyPath = path.join(dir, `${clientName}.key`);

  if (!existsSync(caCertPath) || !existsSync(certPath) || !existsSync(keyPath)) {
    if (isTlsRequired()) {
      throw new Error(
        `[grpc-tls] GRPC_TLS=required but certs missing for client '${clientName}' in '${dir}'.`
      );
    }
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        `[grpc-tls] mTLS certs missing for client '${clientName}' in '${dir}' and NODE_ENV=production. ` +
        `Run: bash scripts/gen-certs.sh and set GRPC_CERTS_DIR`
      );
    }
    warnInsecure("client", clientName, dir);
    return grpc.credentials.createInsecure();
  }

  const caCert = readFileSync(caCertPath);
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);

  process.stderr.write(`[grpc-tls] mTLS enabled for client '${clientName}'\n`);
  return grpc.credentials.createSsl(caCert, key, cert);
}
