/**
 * grpc-config.ts — Centralized gRPC configuration, loaded once at startup.
 *
 * All process.env reads happen here, in `loadGrpcConfig()`.
 * Service methods receive a GrpcConfig object instead of reaching into
 * process.env at runtime.
 */
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface GrpcConfig {
  /** Directory containing TLS certs (ca.crt, {name}.crt, {name}.key) */
  grpcCertsDir: string;

  /** Whether mTLS is required or optional */
  grpcTls: "required" | "optional";

  /** Runtime environment: "development" | "production" | "test" etc. */
  nodeEnv: string;

  /** gRPC bind address for the agent-runtime server */
  agentRuntimeAddr: string;
}

/** Singleton config loaded once at import time. */
let _cached: GrpcConfig | undefined;

/**
 * Load gRPC configuration from environment variables.
 *
 * Defaults:
 *   - grpcCertsDir:  GRPC_CERTS_DIR env or "./certs"
 *   - grpcTls:       GRPC_TLS env or "optional"
 *   - nodeEnv:       NODE_ENV env or "development"
 *   - agentRuntimeAddr: AGENT_RUNTIME_ADDR env or "0.0.0.0:19001"
 *
 * The result is cached: subsequent calls return the same frozen config.
 * To force a reload (e.g. in tests), pass `forceReload = true`.
 */
export function loadGrpcConfig(forceReload = false): GrpcConfig {
  if (!forceReload && _cached) return _cached;

  const config: GrpcConfig = {
    grpcCertsDir:
      process.env["GRPC_CERTS_DIR"] ?? "./certs",
    grpcTls:
      process.env["GRPC_TLS"] === "required" ? "required" : "optional",
    nodeEnv:
      process.env["NODE_ENV"] ?? "development",
    agentRuntimeAddr:
      process.env["AGENT_RUNTIME_ADDR"] ?? "0.0.0.0:19001",
  };

  _cached = Object.freeze(config);
  return _cached;
}

/**
 * Load mTLS server credentials using the given config.
 *
 * This is the refactored version that receives a config object instead
 * of reading process.env directly. The legacy `serverCredentials(name)`
 * in loader.ts delegates to this via `loadGrpcConfig()`.
 */
export function getServerCredentials(
  serviceName: string,
  config: GrpcConfig,
): { certsDir: string; tls: "required" | "optional" } {
  return { certsDir: config.grpcCertsDir, tls: config.grpcTls };
}

/**
 * Load mTLS client credentials using the given config.
 */
export function getClientCredentials(
  clientName: string,
  config: GrpcConfig,
): { certsDir: string; tls: "required" | "optional" } {
  return { certsDir: config.grpcCertsDir, tls: config.grpcTls };
}

/** For backward compat: extract cert info from config (used by loader.ts). */
export function resolveCertPaths(
  name: string,
  certsDir: string,
): { caCertPath: string; certPath: string; keyPath: string } {
  return {
    caCertPath: path.join(certsDir, "ca.crt"),
    certPath: path.join(certsDir, `${name}.crt`),
    keyPath: path.join(certsDir, `${name}.key`),
  };
}

/** Read cert files from disk. Returns null if any file is missing. */
export function readCertFiles(
  certPaths: ReturnType<typeof resolveCertPaths>,
): { caCert: Buffer; cert: Buffer; key: Buffer } | null {
  const { caCertPath, certPath, keyPath } = certPaths;
  if (!existsSync(caCertPath) || !existsSync(certPath) || !existsSync(keyPath)) return null;

  return {
    caCert: readFileSync(caCertPath),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}
