#!/usr/bin/env bash
# REQUIRES: bash (not sh-compatible). Windows users: run via Git Bash or WSL2.
# start-dev.sh — One-command local development startup for Tessera
#
# Usage:
#   bash scripts/start-dev.sh          # Start all services
#   bash scripts/start-dev.sh --build  # Force rebuild before starting
#   bash scripts/start-dev.sh --clean  # Stop, remove volumes, then start fresh
#
# Prerequisites: node >= 22, pnpm >= 9, docker with compose plugin
# Optional: gVisor (runsc) for full sandbox isolation

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Colour

ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
fail() { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
header() { echo -e "\n${BOLD}$*${NC}"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Parse flags ────────────────────────────────────────────────────────────
BUILD_FLAG=""
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_FLAG="--build" ;;
    --clean) CLEAN=true ;;
    --help|-h)
      echo "Usage: $0 [--build] [--clean]"
      echo "  --build  Force Docker image rebuild"
      echo "  --clean  Wipe volumes and restart fresh"
      exit 0
      ;;
    *) warn "Unknown flag: $arg" ;;
  esac
done

header "Tessera — Dev Startup"

# ── 1. Prerequisites ───────────────────────────────────────────────────────
header "1/5  Checking prerequisites"

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fail "$1 not found. $2"
  fi
  ok "$1 found ($(command -v "$1"))"
}

check_cmd node  "Install from https://nodejs.org (>= 22 required)"
check_cmd pnpm  "Install: npm install -g pnpm"
check_cmd docker "Install from https://docs.docker.com/get-docker/"

# Check node version
NODE_MAJOR=$(node --version | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js >= 22 required (found v$(node --version | tr -d 'v'))"
fi
ok "Node.js $(node --version)"

# Check docker compose plugin
if ! docker compose version &>/dev/null 2>&1; then
  fail "Docker Compose plugin not found. Update Docker Desktop or install the plugin."
fi
ok "Docker Compose $(docker compose version --short)"

# Check gVisor (optional)
if command -v runsc &>/dev/null; then
  ok "gVisor (runsc) found — full sandbox isolation available"
else
  warn "gVisor (runsc) not found — TESSERA_ALLOW_RUNC=true will be set (dev only)"
  export TESSERA_ALLOW_RUNC=true
fi

# ── 2. Environment ─────────────────────────────────────────────────────────
header "2/5  Checking environment"

cd "$ROOT"

if [ ! -f .env ]; then
  info "No .env found — copying .env.example to .env"
  cp .env.example .env
  warn "Created .env from example. Please review and set your API keys:"
  warn "  \$EDITOR .env"
  echo ""
  warn "At minimum, set one LLM API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)"
  echo ""
  read -rp "Press Enter to continue with defaults, or Ctrl-C to edit first... "
else
  ok ".env found"
fi

# Warn if no LLM key is set
# shellcheck disable=SC1091
source .env 2>/dev/null || true
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${OLLAMA_BASE_URL:-}" ]; then
  warn "No LLM API key detected. Set at least one in .env:"
  warn "  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or OLLAMA_BASE_URL"
fi

if [ -z "${GATEWAY_HMAC_SECRET:-}" ]; then
  GENERATED_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  warn "GATEWAY_HMAC_SECRET not set — using generated value for this session:"
  warn "  $GENERATED_SECRET"
  warn "Add it to .env to make it permanent."
  export GATEWAY_HMAC_SECRET="$GENERATED_SECRET"
fi

# ── 3. mTLS Certificates ───────────────────────────────────────────────────
header "3/5  mTLS certificates"

if [ "${GRPC_TLS:-false}" = "true" ]; then
  if [ ! -d certs ] || [ -z "$(ls -A certs/*.crt 2>/dev/null)" ]; then
    info "Generating mTLS certificates..."
    node scripts/gen-certs.mjs
    ok "Certificates generated in ./certs/"
  else
    ok "Certificates already exist in ./certs/"
  fi
else
  info "GRPC_TLS=false — skipping certificate generation (insecure transport, dev only)"
fi

# ── 4. Install dependencies ────────────────────────────────────────────────
header "4/5  Installing dependencies"

if [ ! -d node_modules ] || [ ! -d packages/shared/node_modules ]; then
  info "Running pnpm install..."
  pnpm install --frozen-lockfile
  ok "Dependencies installed"
else
  ok "node_modules present (run 'pnpm install' if you see import errors)"
fi

# ── 5. Start Docker Compose ────────────────────────────────────────────────
header "5/5  Starting services"

if [ "$CLEAN" = true ]; then
  info "Cleaning volumes..."
  docker compose -f docker-compose.dev.yml down -v --remove-orphans 2>/dev/null || true
  ok "Volumes wiped"
fi

COMPOSE_CMD="docker compose -f docker-compose.dev.yml up $BUILD_FLAG"

echo ""
echo -e "${BOLD}Starting Tessera stack...${NC}"
echo ""
echo "  Services:"
echo "    gateway        → http://127.0.0.1:${GATEWAY_PORT:-18789}"
echo "    agent-runtime  → grpc://127.0.0.1:19001"
echo "    vault          → grpc://127.0.0.1:19002"
echo "    audit          → grpc://127.0.0.1:19003"
echo "    sandbox        → grpc://127.0.0.1:19004"
echo "    skills         → grpc://127.0.0.1:19005"
echo ""
echo "  Webchat client:"
echo "    open packages/channels/webchat/src/static/client.html"
echo ""
echo "  Health check:"
echo "    curl http://127.0.0.1:${GATEWAY_PORT:-18789}/health"
echo ""
echo "  Generate a token:"
echo "    pnpm --filter '@tessera/cli' exec tessera token generate --user dev"
echo ""
echo -e "  Press ${BOLD}Ctrl-C${NC} to stop all services."
echo ""

# shellcheck disable=SC2086
exec $COMPOSE_CMD
