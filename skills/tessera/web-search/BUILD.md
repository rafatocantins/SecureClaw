# tessera/web-search — Build & Install Guide

Searches Google via SerpAPI and returns organic results (title, link, snippet).

## Prerequisites

- Docker installed and running
- `tessera` CLI built (`pnpm -r build` from repo root)
- A [SerpAPI](https://serpapi.com) account (free tier: 100 searches/month)
- Gateway running with a valid `GATEWAY_TOKEN`

## 1. Build the Docker image

```bash
cd skills/tessera/web-search
docker build -t tessera/web-search:1.0.0 .
```

## 2. Generate a signing key (once per developer)

```bash
tessera skill keygen --out keys/
# Produces: keys/tessera-skill-key.priv  keys/tessera-skill-key.pub
```

## 3. Sign the manifest

```bash
tessera skill sign \
  --template manifest.template.json \
  --key keys/tessera-skill-key.priv \
  --out manifest.signed.json
```

The signed manifest embeds your public key and an Ed25519 signature over the canonical payload.

## 4. Install locally

```bash
tessera skill install-local manifest.signed.json \
  --token "$GATEWAY_TOKEN"
```

## 5. Store the SerpAPI key in the vault

```bash
tessera vault store serpapi-key "YOUR_SERPAPI_KEY" \
  --token "$GATEWAY_TOKEN"
```

Verify it was stored:

```bash
tessera vault list --token "$GATEWAY_TOKEN"
```

## 6. Test it

Send a chat message asking the agent to search for something:

> "Search the web for the latest news on AI safety"

The agent will call `web_search`, the vault will inject the API key (the LLM never
sees it), and results will be returned as a JSON object with `title`, `link`, and
`snippet` for each result.

## Revoke / rotate the key

```bash
tessera vault delete serpapi-key --token "$GATEWAY_TOKEN"
tessera vault store serpapi-key "NEW_KEY" --token "$GATEWAY_TOKEN"
```

## Security notes

- The `serpapi-key` is injected by the vault at execution time using `__VAULT_REF:uuid__`
  placeholders — it is never visible to the LLM or stored in message history.
- The container runs as non-root UID 10001 with a read-only filesystem.
- Network access is restricted to `serpapi.com` in the manifest's `allowed_domains`.
