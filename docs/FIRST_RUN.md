# Tessera — First Run Guide

Get Tessera running locally in under 10 minutes.

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | >= 22.13 | Required for `node:sqlite` built-in. Use [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) to manage versions. |
| pnpm | >= 9.0 | Install: `npm install -g pnpm` |
| Docker Desktop | Latest stable | Required only for sandbox tool execution and `pnpm run dev:docker`. |
| Git | Any | For cloning the repository. |

> **Node version check:** `node --version` must show `v22.13.0` or higher. The built-in
> SQLite module (`node:sqlite`) used by the audit and memory services is only available
> unflagged from Node 22.13+.

---

## 1. Clone the repository

```bash
git clone https://github.com/rafatocantins/Tessera.git
cd Tessera
```

---

## 2. Install dependencies

```bash
pnpm install
```

pnpm will install all workspace packages in a single step. This creates a shared
`node_modules` store and links each package.

---

## 3. Configure your environment

Run the interactive setup wizard:

```bash
pnpm --filter @tessera/cli exec tessera init
```

The wizard will:
1. Generate a random `GATEWAY_HMAC_SECRET` (64-char hex)
2. Generate a random `VAULT_MASTER_KEY` (32-byte key)
3. Prompt for your LLM API key (Anthropic, OpenAI, or Gemini)
4. Write a `.env` file in the project root with permissions `0600`

The `.env` file is git-ignored. Never commit it.

If you prefer to configure manually, copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
# then edit .env with your preferred editor
```

At minimum, set one LLM key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

---

## 4. Build all packages

```bash
pnpm -r build
```

This compiles all 11 TypeScript packages and the control-ui React app. On a cold build,
expect 30-60 seconds. Subsequent builds are faster due to TypeScript incremental compilation.

---

## 5. Start the development stack

```bash
pnpm dev
```

This starts all services concurrently using `concurrently`:

| Service | Address |
|---------|---------|
| Gateway (HTTP) | http://127.0.0.1:18789 |
| Agent Runtime (gRPC) | grpc://127.0.0.1:19001 |
| Credential Vault (gRPC) | grpc://127.0.0.1:19002 |
| Audit System (gRPC) | grpc://127.0.0.1:19003 |
| Sandbox Runtime (gRPC) | grpc://127.0.0.1:19004 |
| Skills Engine (gRPC) | grpc://127.0.0.1:19005 |
| Memory Store (gRPC) | grpc://127.0.0.1:19006 |
| Control UI (Vite) | http://127.0.0.1:5173 |

> **Sandbox note:** The sandbox runtime requires gVisor (`runsc`) for full isolation.
> If `runsc` is not installed (the typical case for local development), set
> `TESSERA_ALLOW_RUNC=true` in your `.env`. The `pnpm dev` script sets this automatically
> via `cross-env`.

To start only backend services (without the UI):

```bash
pnpm dev:services
```

---

## 6. Verify the gateway is healthy

```bash
curl http://127.0.0.1:18789/health
```

Expected response: `{"status":"ok"}`

---

## 7. Generate a token and open the Control UI

Generate an HMAC token for the `dev` user:

```bash
pnpm --filter '@tessera/cli' exec tessera token generate --user dev
```

The token will be printed to stdout. Copy it.

Open the Control UI in your browser:

```
http://127.0.0.1:5173
```

Paste the token when prompted. The session dot in the top-right corner turns green when
connected. The token expires after 5 minutes by default; the UI silently refreshes it.

---

## macOS-specific notes (Apple Silicon / M-series)

### Node.js arm64

Install Node.js for arm64 using `fnm` or `nvm` — avoid the Intel (x86_64) Rosetta build,
which is slower and occasionally causes native module issues:

```bash
# Using fnm (recommended)
brew install fnm
fnm install 22
fnm use 22
```

Confirm you are running native arm64 Node: `node -p "process.arch"` should print `arm64`.

### OpenSSL and mTLS certificates

If you need mTLS for gRPC (`GRPC_TLS=true`), generate certificates with:

```bash
bash scripts/gen-certs.sh
```

This requires `openssl` to be installed. On macOS 14+, `openssl` from Homebrew is preferred
over the system LibreSSL:

```bash
brew install openssl
```

If `openssl` is not on your PATH after install, add Homebrew's bin to your shell profile:

```bash
echo 'export PATH="$(brew --prefix openssl)/bin:$PATH"' >> ~/.zprofile
```

### macOS Keychain (credential vault)

The credential vault uses `keytar` to store secrets in the macOS Keychain when available.
On first use, macOS may prompt for Keychain access — allow it. If `keytar` is unavailable
(headless or CI), the vault falls back to AES-256-GCM encrypted file storage using
`VAULT_MASTER_KEY`.

### Gatekeeper and Docker Desktop

Docker Desktop for Apple Silicon requires Rosetta 2. If Docker Desktop fails to start after
installation:

```bash
softwareupdate --install-rosetta --agree-to-license
```

---

## Windows-specific notes (Windows 11, native — no WSL required)

### Primary path: pnpm dev

`pnpm install` and `pnpm dev` are fully cross-platform. They use:
- `concurrently` (Node.js package) for running services in parallel
- `cross-env` (Node.js package) for setting environment variables
- No bash, no Unix-specific tools

### PowerShell vs CMD

All `pnpm` commands work in both PowerShell and CMD. The recommended terminal is
Windows Terminal with PowerShell 7+.

Do not use PowerShell's built-in `curl` alias (`Invoke-WebRequest`) for the health check.
Use `curl.exe` instead:

```powershell
curl.exe http://127.0.0.1:18789/health
```

### Path separators

Node.js handles both `/` and `\` on Windows for most paths. The `.env` file supports both
separators for data directory overrides. Using forward slashes (`/`) is recommended for
consistency with the `.env.example` documentation format:

```
AUDIT_DATA_DIR=C:/tessera/audit
```

### Data directory defaults on Windows

When `AUDIT_DATA_DIR`, `VAULT_DATA_DIR`, and similar variables are not set, services default
to `os.tmpdir()`, which resolves to `C:\Users\<user>\AppData\Local\Temp` on Windows. This
is correct and requires no manual configuration.

If you want persistent data across reboots, set these variables explicitly in `.env`:

```
AUDIT_DATA_DIR=C:/tessera/audit
VAULT_DATA_DIR=C:/tessera/vault
MEMORY_DATA_DIR=C:/tessera/memory
```

### node:sqlite on Windows

The built-in `node:sqlite` module works on Windows with Node 22.13+. No additional native
binaries or build tools (MSVS, Python) are required.

### Bash scripts (optional, requires Git Bash)

The helper scripts (`scripts/start-dev.sh`, `scripts/gen-certs.sh`) are bash scripts and
require Git Bash or WSL. They are optional — the primary development workflow uses
`pnpm dev` and does not require bash.

If you need mTLS certificates on Windows, use Git Bash:

```bash
# In Git Bash:
bash scripts/gen-certs.sh
```

Or install WSL2:

```powershell
wsl --install
```

### TESSERA_ALLOW_RUNC on Windows

gVisor (`runsc`) is Linux-only and not available on Windows. Set this in your `.env`:

```
TESSERA_ALLOW_RUNC=true
```

`pnpm dev` sets this automatically via `cross-env`, so you only need it in `.env` if you
start services individually (e.g., `pnpm dev:sandbox`).

---

## Troubleshooting

### `pnpm install` fails: "This project requires pnpm"

The root `package.json` has a `preinstall` hook that enforces pnpm via `only-allow`. You
must use pnpm, not npm or yarn.

```bash
npm install -g pnpm
pnpm install
```

### Gateway does not start: "address already in use"

Port 18789 is in use. Either stop the conflicting process or change the port:

```
GATEWAY_PORT=18790
```

### Services fail to start: "GATEWAY_HMAC_SECRET not set"

Run `tessera init` or manually add `GATEWAY_HMAC_SECRET` to your `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output and add to .env:
# GATEWAY_HMAC_SECRET=<copied value>
```

### Control UI shows red dot: token expired

The token expires after `TOKEN_EXPIRY_SECONDS` (default: 300 seconds / 5 minutes). The
Control UI will automatically refresh the token and reconnect. If the dot stays red:

1. Check that the gateway is still running: `curl http://127.0.0.1:18789/health`
2. Generate a new token and reload the page

### SQLite errors on Node 20

`node:sqlite` is not available in Node 20. The audit, memory, and credential vault services
require Node 22.13+. Upgrade Node and re-run.

### Docker not running: sandbox service fails

The sandbox runtime requires Docker to be running when `TESSERA_ALLOW_RUNC=false` (the
production default). In development, set `TESSERA_ALLOW_RUNC=true` in `.env` to bypass
Docker for tool execution.

### macOS: "Operation not permitted" on port 18789

Ports below 1024 are privileged on macOS. Port 18789 is above that threshold and should not
require elevated permissions. If you see this error, check that no other process has bound
the port:

```bash
lsof -i :18789
```

---

## Next steps

- Install bundled skills: see `skills/tessera/read-url/BUILD.md`
- Store API credentials in the vault: `tessera vault store <name> <value>`
- Review security configuration: `CLAUDE.md` (Security invariants section)
- Run the test suite: `pnpm --filter '!@tessera/integration' -r test`
