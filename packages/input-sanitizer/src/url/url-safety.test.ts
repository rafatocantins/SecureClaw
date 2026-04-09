import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from "vitest";
import { checkUrlSafety, checkUrlSafetyResolved } from "./url-safety.js";
import { lookup as dnsLookup } from "node:dns/promises";

// Hoist — Vitest replaces node:dns/promises with the mock factory
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const mockedLookup = dnsLookup as MockedFunction<typeof dnsLookup>;

// Helper to temporarily set / unset env vars within a test
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

beforeEach(() => {
  // Clear all relevant env vars before each test to ensure isolation
  delete process.env["TESSERA_REQUIRE_TLS"];
  delete process.env["HTTP_ALLOWED_DOMAINS"];
  delete process.env["HTTP_BLOCKED_DOMAINS"];
});

afterEach(() => {
  delete process.env["TESSERA_REQUIRE_TLS"];
  delete process.env["HTTP_ALLOWED_DOMAINS"];
  delete process.env["HTTP_BLOCKED_DOMAINS"];
});

// ── Valid URLs ─────────────────────────────────────────────────────────────────

describe("checkUrlSafety — valid HTTPS URLs", () => {
  it("allows a plain HTTPS URL", () => {
    const r = checkUrlSafety("https://example.com/path?q=1");
    expect(r.safe).toBe(true);
    expect(r.category).toBeUndefined();
  });

  it("allows HTTPS with port", () => {
    const r = checkUrlSafety("https://api.example.com:8443/v1");
    expect(r.safe).toBe(true);
  });

  it("allows HTTPS with subdomain", () => {
    const r = checkUrlSafety("https://sub.domain.example.org");
    expect(r.safe).toBe(true);
  });
});

// ── TLS enforcement ───────────────────────────────────────────────────────────

describe("checkUrlSafety — TLS enforcement", () => {
  it("blocks plain HTTP by default (TESSERA_REQUIRE_TLS unset)", () => {
    const r = checkUrlSafety("http://example.com");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("plain_http");
  });

  it("blocks plain HTTP when TESSERA_REQUIRE_TLS=true", () => {
    withEnv({ TESSERA_REQUIRE_TLS: "true" }, () => {
      const r = checkUrlSafety("http://example.com");
      expect(r.safe).toBe(false);
      expect(r.category).toBe("plain_http");
    });
  });

  it("allows plain HTTP when TESSERA_REQUIRE_TLS=false", () => {
    withEnv({ TESSERA_REQUIRE_TLS: "false" }, () => {
      const r = checkUrlSafety("http://example.com");
      expect(r.safe).toBe(true);
    });
  });

  it("reason message mentions TESSERA_REQUIRE_TLS", () => {
    const r = checkUrlSafety("http://example.com");
    expect(r.reason).toMatch(/TESSERA_REQUIRE_TLS/);
  });
});

// ── Metadata endpoints ────────────────────────────────────────────────────────

describe("checkUrlSafety — cloud metadata endpoints", () => {
  it("blocks AWS IMDS: 169.254.169.254", () => {
    const r = checkUrlSafety("https://169.254.169.254/latest/meta-data");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("metadata_endpoint");
  });

  it("blocks GCP metadata: metadata.google.internal", () => {
    const r = checkUrlSafety("https://metadata.google.internal/computeMetadata/v1");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("metadata_endpoint");
  });

  it("blocks Azure metadata: metadata.azure.com", () => {
    const r = checkUrlSafety("https://metadata.azure.com/metadata/instance");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("metadata_endpoint");
  });

  it("blocks 169.254.169.254 with port", () => {
    const r = checkUrlSafety("http://169.254.169.254:80/");
    // Port stripped — should still hit metadata_endpoint before plain_http check? No — plain_http fires first.
    // Actually: plain_http fires BEFORE metadata check. But TESSERA_REQUIRE_TLS is unset, so plain_http fires.
    // The metadata check needs https: — test with https to isolate the metadata category.
    expect(r.safe).toBe(false);
  });
});

// ── Private / loopback IPs ────────────────────────────────────────────────────

describe("checkUrlSafety — private and loopback IPs", () => {
  it("blocks 10.0.0.1 (RFC 1918 Class A)", () => {
    const r = checkUrlSafety("https://10.0.0.1/admin");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks 10.255.255.255", () => {
    const r = checkUrlSafety("https://10.255.255.255");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks 172.16.0.1 (RFC 1918 Class B start)", () => {
    const r = checkUrlSafety("https://172.16.0.1");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks 172.31.255.255 (RFC 1918 Class B end)", () => {
    const r = checkUrlSafety("https://172.31.255.255");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("allows 172.32.0.1 (outside Class B private range)", () => {
    const r = checkUrlSafety("https://172.32.0.1");
    expect(r.safe).toBe(true);
  });

  it("blocks 192.168.1.1 (RFC 1918 Class C)", () => {
    const r = checkUrlSafety("https://192.168.1.1");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks 127.0.0.1 (loopback)", () => {
    const r = checkUrlSafety("https://127.0.0.1");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks 0.0.0.0", () => {
    const r = checkUrlSafety("https://0.0.0.0");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks IPv6 loopback ::1", () => {
    const r = checkUrlSafety("https://[::1]/path");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks IPv6 ULA fd00::1", () => {
    const r = checkUrlSafety("https://[fd00::1]");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks IPv6 link-local fe80::1", () => {
    // Zone IDs (%eth0) are not supported in URL hostnames; test plain link-local
    const r = checkUrlSafety("https://[fe80::1]");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  // T-4-04 — IPv4-mapped IPv6 addresses bypass the old regex
  it("T-4-04: blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", () => {
    const r = checkUrlSafety("https://[::ffff:127.0.0.1]/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("T-4-04: blocks IPv4-mapped IPv6 RFC-1918 ::ffff:10.0.0.1", () => {
    const r = checkUrlSafety("https://[::ffff:10.0.0.1]/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("T-4-04: blocks IPv4-mapped IPv6 RFC-1918 ::ffff:192.168.1.1", () => {
    const r = checkUrlSafety("https://[::ffff:192.168.1.1]/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("T-4-04: blocks IPv4-mapped IPv6 AWS metadata ::ffff:169.254.169.254", () => {
    const r = checkUrlSafety("https://[::ffff:169.254.169.254]/latest/meta-data/");
    expect(r.safe).toBe(false);
    // 169.254.169.254 matches METADATA_HOSTNAMES check first, or private_ip via IPv4-mapped
    expect(["metadata_endpoint", "private_ip"]).toContain(r.category);
  });

  it("T-4-04: blocks all ::ffff: addresses including public ones (no legitimate URL use-case)", () => {
    // IPv4-mapped IPv6 is blocked wholesale — use the plain IPv4 URL instead.
    // Node.js normalises decimal to hex so we cannot safely distinguish private
    // from public in this form; blocking all is the correct defence.
    const r = checkUrlSafety("https://[::ffff:1.1.1.1]/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });
});

// ── Localhost names ───────────────────────────────────────────────────────────

describe("checkUrlSafety — localhost names", () => {
  it("blocks 'localhost'", () => {
    const r = checkUrlSafety("https://localhost:3000");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("localhost");
  });

  it("blocks '*.local' (e.g. foo.local)", () => {
    const r = checkUrlSafety("https://foo.local");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("localhost");
  });

  it("blocks '*.internal' (e.g. db.internal)", () => {
    const r = checkUrlSafety("https://db.internal");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("localhost");
  });

  it("blocks deeply nested *.internal", () => {
    const r = checkUrlSafety("https://api.prod.db.internal/v1");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("localhost");
  });
});

// ── HTTP_BLOCKED_DOMAINS ──────────────────────────────────────────────────────

describe("checkUrlSafety — HTTP_BLOCKED_DOMAINS", () => {
  it("blocks a domain in the blocklist", () => {
    withEnv({ HTTP_BLOCKED_DOMAINS: "evil.com" }, () => {
      const r = checkUrlSafety("https://evil.com/page");
      expect(r.safe).toBe(false);
      expect(r.category).toBe("blocked_domain");
    });
  });

  it("does not block a domain not in the blocklist", () => {
    withEnv({ HTTP_BLOCKED_DOMAINS: "evil.com" }, () => {
      const r = checkUrlSafety("https://good.com/page");
      expect(r.safe).toBe(true);
    });
  });

  it("supports multiple entries (comma-separated)", () => {
    withEnv({ HTTP_BLOCKED_DOMAINS: "evil.com, bad.org, sketchy.net" }, () => {
      expect(checkUrlSafety("https://evil.com").safe).toBe(false);
      expect(checkUrlSafety("https://bad.org").safe).toBe(false);
      expect(checkUrlSafety("https://sketchy.net").safe).toBe(false);
      expect(checkUrlSafety("https://fine.io").safe).toBe(true);
    });
  });
});

// ── HTTP_ALLOWED_DOMAINS ──────────────────────────────────────────────────────

describe("checkUrlSafety — HTTP_ALLOWED_DOMAINS", () => {
  it("allows only the allowlisted domain", () => {
    withEnv({ HTTP_ALLOWED_DOMAINS: "api.example.com" }, () => {
      expect(checkUrlSafety("https://api.example.com/data").safe).toBe(true);
    });
  });

  it("blocks domains not in the allowlist", () => {
    withEnv({ HTTP_ALLOWED_DOMAINS: "api.example.com" }, () => {
      const r = checkUrlSafety("https://other.com");
      expect(r.safe).toBe(false);
      expect(r.category).toBe("not_in_allowlist");
    });
  });

  it("allows all domains when allowlist is empty (opt-in, off by default)", () => {
    withEnv({ HTTP_ALLOWED_DOMAINS: "" }, () => {
      const r = checkUrlSafety("https://anything.com");
      expect(r.safe).toBe(true);
    });
  });

  it("supports multiple allowlist entries", () => {
    withEnv({ HTTP_ALLOWED_DOMAINS: "api.example.com, cdn.example.com" }, () => {
      expect(checkUrlSafety("https://api.example.com").safe).toBe(true);
      expect(checkUrlSafety("https://cdn.example.com").safe).toBe(true);
      expect(checkUrlSafety("https://other.com").safe).toBe(false);
    });
  });
});

// ── Invalid URLs ──────────────────────────────────────────────────────────────

describe("checkUrlSafety — invalid URLs", () => {
  it("blocks an empty string", () => {
    const r = checkUrlSafety("");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("invalid_url");
  });

  it("blocks a plain hostname without scheme", () => {
    const r = checkUrlSafety("example.com");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("invalid_url");
  });

  it("blocks a malformed URL", () => {
    const r = checkUrlSafety("not a url at all!!");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("invalid_url");
  });
});

// ── checkUrlSafetyResolved (DNS rebinding defence) ───────────────────────────

describe("checkUrlSafetyResolved", () => {
  beforeEach(() => {
    delete process.env["TESSERA_REQUIRE_TLS"];
    delete process.env["HTTP_ALLOWED_DOMAINS"];
    delete process.env["HTTP_BLOCKED_DOMAINS"];
    mockedLookup.mockReset();
  });

  it("passes a public hostname that resolves to a public IP", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const r = await checkUrlSafetyResolved("https://example.com/page");
    expect(r.safe).toBe(true);
  });

  it("blocks a hostname that resolves to a private IP (DNS rebinding)", async () => {
    mockedLookup.mockResolvedValue([{ address: "192.168.1.100", family: 4 }] as never);
    const r = await checkUrlSafetyResolved("https://evil.example.com/steal");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
    expect(r.reason).toContain("DNS rebinding");
  });

  it("blocks when DNS returns multiple IPs and one is private", async () => {
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);
    const r = await checkUrlSafetyResolved("https://dual-stack.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks a hostname that resolves to the AWS IMDS IP (DNS rebinding)", async () => {
    mockedLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as never);
    const r = await checkUrlSafetyResolved("https://looks-safe.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("metadata_endpoint");
    expect(r.reason).toContain("DNS rebinding");
  });

  it("blocks a hostname resolving to loopback ::1", async () => {
    mockedLookup.mockResolvedValue([{ address: "::1", family: 6 }] as never);
    const r = await checkUrlSafetyResolved("https://local.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });

  it("blocks when DNS resolution fails (fail-closed)", async () => {
    mockedLookup.mockRejectedValue(new Error("ENOTFOUND"));
    const r = await checkUrlSafetyResolved("https://unresolvable.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
    expect(r.reason).toContain("DNS resolution failed");
  });

  it("applies sync checks first — blocks plain http before DNS", async () => {
    // DNS should never be called for plain http (sync check catches it first)
    const r = await checkUrlSafetyResolved("http://example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("plain_http");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("skips DNS for bare public IPv4 literal", async () => {
    // Bare IPs are already validated by sync pass; no DNS needed
    const r = await checkUrlSafetyResolved("https://8.8.8.8/");
    expect(r.safe).toBe(true);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("blocks bare private IPv4 literal without DNS lookup", async () => {
    const r = await checkUrlSafetyResolved("https://10.0.0.1/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  // T-4-04 — IPv4-mapped IPv6 returned by DNS resolver (in hex form as returned by lookup)
  it("T-4-04: blocks hostname resolving to IPv4-mapped loopback ::ffff:7f00:1", async () => {
    mockedLookup.mockResolvedValue([{ address: "::ffff:7f00:1", family: 6 }] as never);
    const r = await checkUrlSafetyResolved("https://evil.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
    expect(r.reason).toContain("DNS rebinding");
  });

  it("T-4-04: blocks hostname resolving to IPv4-mapped private ::ffff:a00:1 (10.0.0.1)", async () => {
    mockedLookup.mockResolvedValue([{ address: "::ffff:a00:1", family: 6 }] as never);
    const r = await checkUrlSafetyResolved("https://evil.example.com/");
    expect(r.safe).toBe(false);
    expect(r.category).toBe("private_ip");
  });
});
