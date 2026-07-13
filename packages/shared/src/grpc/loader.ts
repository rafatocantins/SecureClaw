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
import {
  type GrpcConfig,
  loadGrpcConfig,
  resolveCertPaths,
  readCertFiles,
} from "../config/grpc-config.js";

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
 * @param config       — optional GrpcConfig; falls back to loadGrpcConfig() if omitted.
 *
 * Returns SSL credentials with mutual TLS (client cert required).
 * Falls back to insecure() when cert files are absent, unless config.grpcTls="required".
 */
export function serverCredentials(
  serviceName: string,
  config?: GrpcConfig
): grpc.ServerCredentials {
  const cfg = config ?? loadGrpcConfig();
  const certsDir = cfg.grpcCertsDir;
  const paths = resolveCertPaths(serviceName, certsDir);
  const files = readCertFiles(paths);

  if (!files) {
    if (cfg.grpcTls === "required") {
      throw new Error(
        `[grpc-tls] GRPC_TLS=required but certs missing for server '${serviceName}' in '${certsDir}'. ` +
        `Run: bash scripts/gen-certs.sh`
      );
    }
    if (cfg.nodeEnv === "production") {
      throw new Error(
        `[grpc-tls] Refusing to start with insecure gRPC in production. ` +
        `Certs missing for server '${serviceName}' in '${certsDir}'. ` +
        `Run: bash scripts/gen-certs.sh`
      );
    }
    warnInsecure("server", serviceName, certsDir);
    return grpc.ServerCredentials.createInsecure();
  }

  process.stderr.write(`[grpc-tls] mTLS enabled for server '${serviceName}'\n`);
  // requireClientCert = true enforces mutual TLS
  return grpc.ServerCredentials.createSsl(
    files.caCert,
    [{ cert_chain: files.cert, private_key: files.key }],
    true
  );
}

/**
 * Load mTLS client credentials for a named client service.
 *
 * @param clientName — the name of the calling service (e.g. "gateway", "agent-runtime")
 *                     used to load the client's own cert for mutual authentication.
 * @param config     — optional GrpcConfig; falls back to loadGrpcConfig() if omitted.
 *
 * Falls back to insecure() when cert files are absent, unless config.grpcTls="required".
 */
export function clientCredentials(
  clientName: string,
  config?: GrpcConfig
): grpc.ChannelCredentials {
  const cfg = config ?? loadGrpcConfig();
  const certsDir = cfg.grpcCertsDir;
  const paths = resolveCertPaths(clientName, certsDir);
  const files = readCertFiles(paths);

  if (!files) {
    if (cfg.grpcTls === "required") {
      throw new Error(
        `[grpc-tls] GRPC_TLS=required but certs missing for client '${clientName}' in '${certsDir}'.`
      );
    }
    if (cfg.nodeEnv === "production") {
      throw new Error(
        `[grpc-tls] Refusing to start with insecure gRPC in production. ` +
        `Certs missing for client '${clientName}' in '${certsDir}'. ` +
        `Run: bash scripts/gen-certs.sh`
      );
    }
    warnInsecure("client", clientName, certsDir);
    return grpc.credentials.createInsecure();
  }

  process.stderr.write(`[grpc-tls] mTLS enabled for client '${clientName}'\n`);
  return grpc.credentials.createSsl(files.caCert, files.key, files.cert);
}
