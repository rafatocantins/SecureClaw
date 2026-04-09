#!/usr/bin/env node
/**
 * read-url — Tessera skill tool
 *
 * Fetches a URL and returns its text content.
 * Input is passed via the TOOL_INPUT environment variable as JSON.
 *
 * Input schema:
 *   { "url": "https://..." }
 *
 * Output (stdout, JSON):
 *   { "url": "...", "status": 200, "content_type": "text/html", "content": "...", "truncated": false }
 *
 * The sandbox SSRF layer blocks private IPs and metadata endpoints before this
 * tool is ever invoked — but we add an extra client-side guard anyway.
 *
 * T-4-03: Redirects are followed manually so every redirect destination is
 * re-validated through the SSRF block-list before the next request is made.
 * `redirect: "follow"` would bypass the check on the redirected URL.
 */

const MAX_BYTES = 50_000; // cap output at 50 KB to avoid flooding the LLM context
const TIMEOUT_MS = 25_000;
const MAX_REDIRECTS = 5;

// Private/loopback ranges — defence-in-depth even inside the container
const BLOCKED_PATTERNS = [
  /^https?:\/\/169\.254\./,           // AWS/Azure metadata
  /^https?:\/\/metadata\.google\.internal/,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/127\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/\[::ffff:/i,           // T-4-04: IPv4-mapped IPv6 literals
  /^https?:\/\/localhost/i,
];

function isBlocked(url) {
  return BLOCKED_PATTERNS.some((re) => re.test(url));
}

/**
 * Fetch a URL, manually following redirects and re-checking each hop.
 * Throws if a redirect target is blocked or MAX_REDIRECTS is exceeded.
 */
async function safeFetch(startUrl) {
  let currentUrl = startUrl;
  let hops = 0;

  while (hops <= MAX_REDIRECTS) {
    if (isBlocked(currentUrl)) {
      throw new Error(`URL is blocked by SSRF protection: ${currentUrl}`);
    }
    if (!currentUrl.startsWith("https://")) {
      throw new Error("Only HTTPS URLs are allowed");
    }

    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "Tessera/1.0 (skill:tessera/read-url)",
        "Accept": "text/html,text/plain,application/json,*/*",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual", // T-4-03: never auto-follow — validate each hop
    });

    // 3xx — validate the redirect target before following
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response (${response.status}) missing Location header`);
      }
      // Resolve relative Location against current URL
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = nextUrl;
      hops++;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (limit: ${MAX_REDIRECTS})`);
}

async function main() {
  const rawInput = process.env["TOOL_INPUT"];
  if (!rawInput) {
    process.stderr.write("Error: TOOL_INPUT environment variable not set\n");
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    process.stderr.write("Error: TOOL_INPUT is not valid JSON\n");
    process.exit(1);
  }

  const { url } = input;
  if (!url || typeof url !== "string") {
    process.stderr.write("Error: 'url' field is required and must be a string\n");
    process.exit(1);
  }

  if (isBlocked(url)) {
    process.stderr.write(`Error: URL is blocked by SSRF protection: ${url}\n`);
    process.exit(1);
  }

  if (!url.startsWith("https://")) {
    process.stderr.write("Error: Only HTTPS URLs are allowed\n");
    process.exit(1);
  }

  let response;
  try {
    response = await safeFetch(url);
  } catch (err) {
    process.stderr.write(`Fetch error: ${err.message}\n`);
    process.exit(1);
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    process.stderr.write(`Read error: ${err.message}\n`);
    process.exit(1);
  }

  const truncated = text.length > MAX_BYTES;
  const content = truncated ? text.slice(0, MAX_BYTES) : text;

  const result = {
    url,
    status: response.status,
    content_type: response.headers.get("content-type") ?? "",
    content,
    truncated,
    ...(truncated ? { note: `Content truncated to ${MAX_BYTES} bytes` } : {}),
  };

  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exit(1);
});
