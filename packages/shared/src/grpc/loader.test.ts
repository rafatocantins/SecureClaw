import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("@grpc/grpc-js", () => ({
  ServerCredentials: {
    createInsecure: vi.fn(() => "insecure-server-credentials" as unknown as any),
    createSsl: vi.fn(() => "ssl-server-credentials" as unknown as any),
  },
  credentials: {
    createInsecure: vi.fn(() => "insecure-client-credentials" as unknown as any),
    createSsl: vi.fn(() => "ssl-client-credentials" as unknown as any),
  },
  loadPackageDefinition: vi.fn(),
}));

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { serverCredentials, clientCredentials } from "./loader.js";

const mockedExistsSync = vi.mocked(existsSync);

describe("serverCredentials", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["NODE_ENV"];
    delete process.env["GRPC_TLS"];
    delete process.env["GRPC_CERTS_DIR"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when GRPC_TLS=required and certs are missing", () => {
    process.env["GRPC_TLS"] = "required";
    mockedExistsSync.mockReturnValue(false);

    expect(() => serverCredentials("my-service")).toThrow(
      /GRPC_TLS=required but certs missing/
    );
  });

  it("throws when NODE_ENV=production and certs are missing", () => {
    process.env["NODE_ENV"] = "production";
    mockedExistsSync.mockReturnValue(false);

    expect(() => serverCredentials("my-service")).toThrow(
      /NODE_ENV=production/
    );
  });

  it("error message includes gen-certs.sh and GRPC_CERTS_DIR when NODE_ENV=production", () => {
    process.env["NODE_ENV"] = "production";
    mockedExistsSync.mockReturnValue(false);

    expect(() => serverCredentials("my-service")).toThrow(
      /bash scripts\/gen-certs\.sh and set GRPC_CERTS_DIR/
    );
  });

  it("falls back to createInsecure when NODE_ENV=development and certs are missing", () => {
    process.env["NODE_ENV"] = "development";
    mockedExistsSync.mockReturnValue(false);

    const result = serverCredentials("my-service");

    expect(grpc.ServerCredentials.createInsecure).toHaveBeenCalledOnce();
    expect(result).toBe("insecure-server-credentials");
  });

  it("falls back to createInsecure when NODE_ENV is unset and certs are missing", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = serverCredentials("my-service");

    expect(grpc.ServerCredentials.createInsecure).toHaveBeenCalledOnce();
    expect(result).toBe("insecure-server-credentials");
  });

  it("throws when GRPC_TLS=required regardless of NODE_ENV=development", () => {
    process.env["GRPC_TLS"] = "required";
    process.env["NODE_ENV"] = "development";
    mockedExistsSync.mockReturnValue(false);

    expect(() => serverCredentials("my-service")).toThrow(
      /GRPC_TLS=required/
    );
  });

  it("creates SSL credentials when certs exist", () => {
    mockedExistsSync.mockReturnValue(true);

    const result = serverCredentials("my-service");

    expect(grpc.ServerCredentials.createSsl).toHaveBeenCalledOnce();
    expect(result).toBe("ssl-server-credentials");
  });
});

describe("clientCredentials", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env["NODE_ENV"];
    delete process.env["GRPC_TLS"];
    delete process.env["GRPC_CERTS_DIR"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when GRPC_TLS=required and certs are missing", () => {
    process.env["GRPC_TLS"] = "required";
    mockedExistsSync.mockReturnValue(false);

    expect(() => clientCredentials("my-client")).toThrow(
      /GRPC_TLS=required but certs missing/
    );
  });

  it("throws when NODE_ENV=production and certs are missing", () => {
    process.env["NODE_ENV"] = "production";
    mockedExistsSync.mockReturnValue(false);

    expect(() => clientCredentials("my-client")).toThrow(
      /NODE_ENV=production/
    );
  });

  it("error message includes gen-certs.sh and GRPC_CERTS_DIR when NODE_ENV=production (client)", () => {
    process.env["NODE_ENV"] = "production";
    mockedExistsSync.mockReturnValue(false);

    expect(() => clientCredentials("my-client")).toThrow(
      /bash scripts\/gen-certs\.sh and set GRPC_CERTS_DIR/
    );
  });

  it("falls back to createInsecure when NODE_ENV=development and certs are missing", () => {
    process.env["NODE_ENV"] = "development";
    mockedExistsSync.mockReturnValue(false);

    const result = clientCredentials("my-client");

    expect(grpc.credentials.createInsecure).toHaveBeenCalledOnce();
    expect(result).toBe("insecure-client-credentials");
  });

  it("falls back to createInsecure when NODE_ENV is unset and certs are missing", () => {
    mockedExistsSync.mockReturnValue(false);

    const result = clientCredentials("my-client");

    expect(grpc.credentials.createInsecure).toHaveBeenCalledOnce();
    expect(result).toBe("insecure-client-credentials");
  });

  it("throws when GRPC_TLS=required regardless of NODE_ENV=development (client)", () => {
    process.env["GRPC_TLS"] = "required";
    process.env["NODE_ENV"] = "development";
    mockedExistsSync.mockReturnValue(false);

    expect(() => clientCredentials("my-client")).toThrow(
      /GRPC_TLS=required/
    );
  });

  it("creates SSL credentials when certs exist (client)", () => {
    mockedExistsSync.mockReturnValue(true);

    const result = clientCredentials("my-client");

    expect(grpc.credentials.createSsl).toHaveBeenCalledOnce();
    expect(result).toBe("ssl-client-credentials");
  });
});
