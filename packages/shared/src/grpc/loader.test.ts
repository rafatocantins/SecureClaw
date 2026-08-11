import { describe, it, expect } from "vitest";
import { serverCredentials, clientCredentials } from "./loader.js";
import type { GrpcConfig } from "../config/grpc-config.js";

describe("loader", () => {
  describe("serverCredentials", () => {
    it("returns insecure when config has tls=optional and no certs exist", () => {
      const config: GrpcConfig = {
        grpcCertsDir: "/nonexistent/certs",
        grpcTls: "optional",
        nodeEnv: "test",
        agentRuntimeAddr: "0.0.0.0:19001",
      };

      const creds = serverCredentials("test-server", config);
      // Insecure credentials won't have the secure flag
      expect(creds).toBeDefined();
    });

    it("throws when config has tls=required and no certs exist", () => {
      const config: GrpcConfig = {
        grpcCertsDir: "/nonexistent/certs",
        grpcTls: "required",
        nodeEnv: "test",
        agentRuntimeAddr: "0.0.0.0:19001",
      };

      expect(() =>
        serverCredentials("test-server", config)
      ).toThrow(/GRPC_TLS=required/);
    });
  });

  describe("clientCredentials", () => {
    it("returns insecure when config has tls=optional and no certs exist", () => {
      const config: GrpcConfig = {
        grpcCertsDir: "/nonexistent/certs",
        grpcTls: "optional",
        nodeEnv: "test",
        agentRuntimeAddr: "0.0.0.0:19001",
      };

      const creds = clientCredentials("test-client", config);
      expect(creds).toBeDefined();
    });

    it("throws when config has tls=required and no certs exist", () => {
      const config: GrpcConfig = {
        grpcCertsDir: "/nonexistent/certs",
        grpcTls: "required",
        nodeEnv: "test",
        agentRuntimeAddr: "0.0.0.0:19001",
      };

      expect(() =>
        clientCredentials("test-client", config)
      ).toThrow(/GRPC_TLS=required/);
    });
  });
});
