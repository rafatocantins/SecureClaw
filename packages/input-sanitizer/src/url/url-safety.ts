/**
 * url-safety.ts — SSRF prevention for outbound HTTP requests.
 *
 * Sync checks (checkUrlSafety — in order):
 * 1. Invalid URL — parse failure
 * 2. TLS enforcement — http: scheme blocked unless TESSERA_REQUIRE_TLS=false
 * 3. Metadata endpoints — cloud IMDS hostnames
 * 4. Private/loopback IPs — RFC 1918 + loopback + IPv6 private ranges
 * 5. Localhost names — localhost, *.local, *.internal
 * 6. HTTP_BLOCKED_DOMAINS — operator-specified blocklist
 * 7. HTTP_ALLOWED_DOMAINS — operator-specified allowlist (opt-in, empty = all pass)
 *
 * Async check (checkUrlSafetyResolved — DNS rebinding defence):
 * 8. Resolve hostname → validate all returned IPs against private ranges.
 *    Prevents attacks where a public hostname temporarily re-maps to a
 *    private IP between the sync hostname check and the actual fetch.
 */
import { lookup } from "node:dns/promises";

export type UrlSafetyCategory =
  | "invalid_url"
  | "plain_http"
  | "private_ip"
  | "metadata_endpoint"
  | "localhost"
  | "blocked_domain"
  | "not_in_allowlist";

export interface UrlSafetyResult {
  safe: boolean;
  reason?: string;
  category?: UrlSafetyCategory;
}

// Cloud metadata service hostnames (strip port before comparing)
const METADATA_HOSTNAMES = new Set([
  "169.254.169.254",       // AWS IMDS / GCP / Azure link-local
  "metadata.google.internal",
  "metadata.azure.com",
]);

// Regex for private / loopback IPv4 ranges
const PRIVATE_IPV4_RE =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

// Regex for private / loopback IPv6 addresses.
//
// T-4-04: `::ffff:` covers the entire IPv4-mapped IPv6 range (::ffff:0:0/96).
// Node.js normalises decimal notation to hex before putting it in URL.hostname
// (e.g. "::ffff:127.0.0.1" → "::ffff:7f00:1"), so we cannot reliably extract
// an embedded IPv4 string. Blocking all ::ffff: addresses is the correct defence:
// any destination reachable via an IPv4-mapped address is also reachable as a
// plain IPv4 URL, so this restriction has no legitimate use-case impact.
const PRIVATE_IPV6_RE =
  /^(?:::1|::ffff:|fe80:[0-9a-f:]*|fd[0-9a-f]{2}:[0-9a-f:]*)/i;

function isPrivateIp(addr: string): boolean {
  return PRIVATE_IPV4_RE.test(addr) || PRIVATE_IPV6_RE.test(addr);
}

/**
 * Strip brackets from IPv6 literals so `[::1]` → `::1`.
 */
function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Check whether the given raw URL string is safe to request.
 * Pure function — reads only from process.env; no network calls.
 */
export function checkUrlSafety(rawUrl: string): UrlSafetyResult {
  // 1. Parse — reject clearly malformed URLs
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "URL is invalid or cannot be parsed", category: "invalid_url" };
  }

  const hostname = stripBrackets(parsed.hostname.toLowerCase());

  // 2. TLS enforcement — block plain http: unless operator opts out
  if (parsed.protocol === "http:") {
    const requireTls = process.env["TESSERA_REQUIRE_TLS"];
    if (requireTls !== "false") {
      return {
        safe: false,
        reason: "Plain HTTP is not allowed. Use HTTPS or set TESSERA_REQUIRE_TLS=false to permit.",
        category: "plain_http",
      };
    }
  }

  // 3. Metadata endpoints (check before IP range checks — 169.254.169.254 also
  //    matches the private IP range, but we want the more specific label)
  if (METADATA_HOSTNAMES.has(hostname)) {
    return {
      safe: false,
      reason: `Access to cloud metadata endpoint '${hostname}' is blocked (SSRF prevention)`,
      category: "metadata_endpoint",
    };
  }

  // 4. Private / loopback IP ranges (includes IPv4-mapped IPv6 via isPrivateIp)
  if (isPrivateIp(hostname)) {
    return {
      safe: false,
      reason: `Access to private or loopback address '${hostname}' is blocked (SSRF prevention)`,
      category: "private_ip",
    };
  }

  // 5. Localhost names (localhost, *.local, *.internal)
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return {
      safe: false,
      reason: `Access to local hostname '${hostname}' is blocked (SSRF prevention)`,
      category: "localhost",
    };
  }

  // 6. Operator blocklist — HTTP_BLOCKED_DOMAINS (always applied)
  const blockedDomainsEnv = process.env["HTTP_BLOCKED_DOMAINS"] ?? "";
  if (blockedDomainsEnv.trim()) {
    const blocked = blockedDomainsEnv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (blocked.includes(hostname)) {
      return {
        safe: false,
        reason: `Domain '${hostname}' is in the HTTP_BLOCKED_DOMAINS blocklist`,
        category: "blocked_domain",
      };
    }
  }

  // 7. Operator allowlist — HTTP_ALLOWED_DOMAINS (opt-in; empty = all pass)
  const allowedDomainsEnv = process.env["HTTP_ALLOWED_DOMAINS"] ?? "";
  if (allowedDomainsEnv.trim()) {
    const allowed = allowedDomainsEnv.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(hostname)) {
      return {
        safe: false,
        reason: `Domain '${hostname}' is not in the HTTP_ALLOWED_DOMAINS allowlist`,
        category: "not_in_allowlist",
      };
    }
  }

  return { safe: true };
}

/**
 * Async variant — runs all sync checks first, then resolves the hostname via
 * DNS and validates every returned IP against the private/loopback ranges.
 *
 * Use this in the agent loop (before dispatching a tool call) to defend
 * against DNS rebinding: an attacker-controlled hostname may pass the sync
 * string checks but re-resolve to a private IP when the container fetches it.
 *
 * Timeout: 5 seconds. On resolution failure (NXDOMAIN, timeout, network error)
 * the check returns safe=false with category "private_ip" — fail-closed.
 */
export async function checkUrlSafetyResolved(rawUrl: string): Promise<UrlSafetyResult> {
  // 1–7: Run all sync checks first
  const syncResult = checkUrlSafety(rawUrl);
  if (!syncResult.safe) return syncResult;

  // Parse again (already validated above)
  const parsed = new URL(rawUrl);
  const hostname = stripBrackets(parsed.hostname.toLowerCase());

  // Skip DNS resolution for bare IP literals — already checked by sync pass
  const isIpLiteral =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || // IPv4
    /^[0-9a-f:]+$/i.test(hostname);               // IPv6 (no brackets)
  if (isIpLiteral) return { safe: true };

  // 8. Resolve hostname → check all returned IPs
  let addresses: string[];
  try {
    const results = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("DNS timeout")), 5_000)
      ),
    ]);
    addresses = (results as { address: string }[]).map((r) => r.address);
  } catch {
    // DNS resolution failed — fail closed (could be NXDOMAIN or a timeout)
    return {
      safe: false,
      reason: `DNS resolution failed for '${hostname}' — request blocked (SSRF prevention)`,
      category: "private_ip",
    };
  }

  for (const addr of addresses) {
    const normalized = addr.toLowerCase();
    // Cloud metadata IPs — check before generic private ranges
    if (METADATA_HOSTNAMES.has(normalized)) {
      return {
        safe: false,
        reason: `'${hostname}' resolved to cloud metadata IP '${addr}' — DNS rebinding attack blocked`,
        category: "metadata_endpoint",
      };
    }
    if (isPrivateIp(normalized)) {
      return {
        safe: false,
        reason: `'${hostname}' resolved to private/loopback IP '${addr}' — DNS rebinding attack blocked`,
        category: "private_ip",
      };
    }
  }

  return { safe: true };
}
