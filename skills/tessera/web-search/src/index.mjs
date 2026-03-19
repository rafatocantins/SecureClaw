#!/usr/bin/env node
/**
 * web-search — Tessera skill tool
 *
 * Performs a web search via SerpAPI and returns organic results.
 * Input is passed via the TOOL_INPUT environment variable as JSON.
 * The SerpAPI key is injected into TOOL_INPUT by the vault before
 * this container starts — the key is never visible to the LLM.
 *
 * Input schema:
 *   {
 *     "query":       "...",            // required
 *     "num_results": 10,               // optional, 1-10, default 10
 *     "serpapi-key": "<secret>"        // injected by vault, never set by user
 *   }
 *
 * Output (stdout, JSON):
 *   {
 *     "query": "...",
 *     "total_results": "...",
 *     "results": [
 *       { "title": "...", "link": "...", "snippet": "..." }
 *     ]
 *   }
 */

const SERPAPI_URL = "https://serpapi.com/search.json";
const MAX_RESULTS = 10;
const TIMEOUT_MS = 20_000;

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

  const { query } = input;
  if (!query || typeof query !== "string" || !query.trim()) {
    process.stderr.write("Error: 'query' field is required and must be a non-empty string\n");
    process.exit(1);
  }

  const apiKey = input["serpapi-key"];
  if (!apiKey || typeof apiKey !== "string") {
    process.stderr.write(
      "Error: 'serpapi-key' credential not found in vault. " +
      "Run: tessera vault store serpapi-key <your-api-key>\n"
    );
    process.exit(1);
  }

  const numResults = Math.min(
    Math.max(1, Number.isInteger(input.num_results) ? input.num_results : MAX_RESULTS),
    MAX_RESULTS
  );

  const params = new URLSearchParams({
    engine: "google",
    q: query.trim(),
    num: String(numResults),
    api_key: apiKey,
    output: "json",
  });

  const url = `${SERPAPI_URL}?${params.toString()}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "Tessera/1.0 (skill:tessera/web-search)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    process.stderr.write(`SerpAPI fetch error: ${err.message}\n`);
    process.exit(1);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    process.stderr.write(`SerpAPI error ${response.status}: ${text.slice(0, 500)}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    process.stderr.write(`Failed to parse SerpAPI response: ${err.message}\n`);
    process.exit(1);
  }

  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  const results = organic.slice(0, numResults).map((r) => ({
    title: r.title ?? "",
    link: r.link ?? "",
    snippet: r.snippet ?? "",
  }));

  const output = {
    query: query.trim(),
    total_results: data.search_information?.total_results ?? "unknown",
    results,
  };

  process.stdout.write(JSON.stringify(output, null, 2));
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(`Unexpected error: ${err.message}\n`);
  process.exit(1);
});
