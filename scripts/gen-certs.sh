#!/usr/bin/env bash
# SUPERSEDED: This script has been replaced by scripts/gen-certs.mjs (cross-platform Node.js).
# Run: node scripts/gen-certs.mjs
# This file is kept for reference only. Do not use in CI or automated tooling.
#
# gen-certs.sh — Generate self-signed CA and per-service mTLS certificates
# Usage: bash scripts/gen-certs.sh [output_dir]
# Default output: ./certs/
#
# For production, replace this with:
# - HashiCorp Vault PKI secrets engine, OR
# - Let's Encrypt with cert-manager (if using Kubernetes), OR
# - An existing internal CA

set -euo pipefail

CERT_DIR="${1:-./certs}"
mkdir -p "$CERT_DIR"

SERVICES=(
  "gateway"
  "agent-runtime"
  "credential-vault"
  "audit-system"
  "sandbox-runtime"
)

echo "[cert-gen] Generating CA..."
openssl genrsa -out "$CERT_DIR/ca.key" 4096 2>/dev/null
openssl req -new -x509 -days 3650 \
  -key "$CERT_DIR/ca.key" \
  -out "$CERT_DIR/ca.crt" \
  -subj "/CN=Tessera-CA/O=Tessera/OU=Internal" 2>/dev/null
echo "[cert-gen] CA certificate: $CERT_DIR/ca.crt"

for SERVICE in "${SERVICES[@]}"; do
  echo "[cert-gen] Generating certificate for $SERVICE..."
  openssl genrsa -out "$CERT_DIR/$SERVICE.key" 2048 2>/dev/null
  openssl req -new \
    -key "$CERT_DIR/$SERVICE.key" \
    -out "$CERT_DIR/$SERVICE.csr" \
    -subj "/CN=$SERVICE/O=Tessera/OU=Service" 2>/dev/null

  # SAN extension: service name, localhost, and 127.0.0.1 so clients can connect via any of these
  cat > "$CERT_DIR/$SERVICE.ext" <<EOF
subjectAltName=DNS:${SERVICE},DNS:localhost,IP:127.0.0.1
EOF

  openssl x509 -req -days 365 \
    -in "$CERT_DIR/$SERVICE.csr" \
    -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$CERT_DIR/$SERVICE.ext" \
    -out "$CERT_DIR/$SERVICE.crt" 2>/dev/null
  # Remove CSR and ext files — not needed after signing
  rm "$CERT_DIR/$SERVICE.csr" "$CERT_DIR/$SERVICE.ext"
done

# Restrict private key permissions
chmod 600 "$CERT_DIR"/*.key
chmod 644 "$CERT_DIR"/*.crt
chmod 644 "$CERT_DIR"/ca.crt

# Remove CA serial number file
rm -f "$CERT_DIR/ca.srl"

echo ""
echo "[cert-gen] Done! Certificates generated in $CERT_DIR/"
echo "[cert-gen] IMPORTANT: These are self-signed certificates for development."
echo "[cert-gen] Replace with proper CA-signed certificates for production."
echo ""
echo "Generated files:"
ls -la "$CERT_DIR/"
