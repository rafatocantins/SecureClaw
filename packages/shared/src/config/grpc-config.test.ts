import { describe, it, expect } from "vitest";
import { loadGrpcConfig } from "./grpc-config.js";

// Save and restore original env vars
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("GrpcConfig", () => {
  describe("loadGrpcConfig", () => {
    it("returns defaults when no env vars are set", () => {
      withEnv(
        {
          GRPC_CERTS_DIR: undefined,
          GRPC_TLS: undefined,
          NODE_ENV: undefined,
          AGENT_RUNTIME_ADDR: undefined,
        },
        () => {
          const config = loadGrpcConfig(true);
          expect(config.grpcCertsDir).toBe("./certs");
          expect(config.grpcTls).toBe("optional");
          expect(config.nodeEnv).toBe("development");
          expect(config.agentRuntimeAddr).toBe("0.0.0.0:19001");
        }
      );
    });

    it("reads GRPC_CERTS_DIR from env", () => {
      withEnv({ GRPC_CERTS_DIR: "/custom/certs" }, () => {
        const config = loadGrpcConfig(true);
        expect(config.grpcCertsDir).toBe("/custom/certs");
      });
    });

    it("reads GRPC_TLS=required from env", () => {
      withEnv({ GRPC_TLS: "required" }, () => {
        const config = loadGrpcConfig(true);
        expect(config.grpcTls).toBe("required");
      });
    });

    it("treats GRPC_TLS=anything-else as optional", () => {
      withEnv({ GRPC_TLS: "maybe" }, () => {
        const config = loadGrpcConfig(true);
        expect(config.grpcTls).toBe("optional");
      });
    });

    it("reads NODE_ENV from env", () => {
      withEnv({ NODE_ENV: "production" }, () => {
        const config = loadGrpcConfig(true);
        expect(config.nodeEnv).toBe("production");
      });
    });

    it("reads AGENT_RUNTIME_ADDR from env", () => {
      withEnv({ AGENT_RUNTIME_ADDR: "127.0.0.1:9999" }, () => {
        const config = loadGrpcConfig(true);
        expect(config.agentRuntimeAddr).toBe("127.0.0.1:9999");
      });
    });

    it("caches config on subsequent calls", () => {
      withEnv(
        {
          GRPC_CERTS_DIR: undefined,
          GRPC_TLS: undefined,
          NODE_ENV: undefined,
          AGENT_RUNTIME_ADDR: undefined,
        },
        () => {
          const c1 = loadGrpcConfig(true);
          const c2 = loadGrpcConfig();
          expect(c1).toBe(c2); // reference equality from cache
        }
      );
    });

    it("forceReload=true returns a new config object", () => {
      withEnv(
        {
          GRPC_CERTS_DIR: undefined,
          GRPC_TLS: undefined,
          NODE_ENV: undefined,
          AGENT_RUNTIME_ADDR: undefined,
        },
        () => {
          const c1 = loadGrpcConfig(true);
          const c2 = loadGrpcConfig(true);
          expect(c1).not.toBe(c2);
          // Values should be the same (defaults)
          expect(c1.grpcCertsDir).toBe(c2.grpcCertsDir);
        }
      );
    });
  });
});
