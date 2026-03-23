#!/usr/bin/env node
/**
 * gen-certs.mjs — Generate self-signed CA and per-service mTLS certificates
 *
 * Cross-platform replacement for scripts/gen-certs.sh
 * Requires: Node.js 18+ and openssl on PATH
 *
 * Usage:
 *   node scripts/gen-certs.mjs [output_dir]
 *   Default output: ./certs/
 *
 * For production, replace this with:
 *   - HashiCorp Vault PKI secrets engine, OR
 *   - Let's Encrypt with cert-manager (if using Kubernetes), OR
 *   - An existing internal CA
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const certDir = process.argv[2] ?? './certs';

// Check openssl availability
try {
  execFileSync('openssl', ['version'], { stdio: 'pipe' });
} catch {
  console.error('ERROR: openssl not found on PATH. Install openssl and try again.');
  process.exit(1);
}

mkdirSync(certDir, { recursive: true });

const SERVICES = [
  'gateway',
  'agent-runtime',
  'credential-vault',
  'audit-system',
  'sandbox-runtime',
];

// ── CA ──────────────────────────────────────────────────────────────────────

console.log('[cert-gen] Generating CA...');

execFileSync('openssl', [
  'genrsa', '-out', join(certDir, 'ca.key'), '4096',
], { stdio: 'pipe' });

execFileSync('openssl', [
  'req', '-new', '-x509', '-days', '3650',
  '-key', join(certDir, 'ca.key'),
  '-out', join(certDir, 'ca.crt'),
  '-subj', '/CN=Tessera-CA/O=Tessera/OU=Internal',
], { stdio: 'pipe' });

console.log(`[cert-gen] CA certificate: ${join(certDir, 'ca.crt')}`);

// ── Per-service certs ────────────────────────────────────────────────────────

for (const svc of SERVICES) {
  console.log(`[cert-gen] Generating certificate for ${svc}...`);

  const key = join(certDir, `${svc}.key`);
  const csr = join(certDir, `${svc}.csr`);
  const ext = join(certDir, `${svc}.ext`);
  const crt = join(certDir, `${svc}.crt`);

  // Service key
  execFileSync('openssl', ['genrsa', '-out', key, '2048'], { stdio: 'pipe' });

  // CSR
  execFileSync('openssl', [
    'req', '-new',
    '-key', key,
    '-out', csr,
    '-subj', `/CN=${svc}/O=Tessera/OU=Service`,
  ], { stdio: 'pipe' });

  // SAN extension file — service name, localhost, 127.0.0.1
  writeFileSync(ext, `subjectAltName=DNS:${svc},DNS:localhost,IP:127.0.0.1\n`);

  // Sign CSR with CA
  execFileSync('openssl', [
    'x509', '-req', '-days', '365',
    '-in', csr,
    '-CA', join(certDir, 'ca.crt'),
    '-CAkey', join(certDir, 'ca.key'),
    '-CAcreateserial',
    '-extfile', ext,
    '-out', crt,
  ], { stdio: 'pipe' });

  // Remove CSR and ext files — not needed after signing
  rmSync(csr);
  rmSync(ext);
}

// Remove CA serial number file
rmSync(join(certDir, 'ca.srl'), { force: true });

// Restrict private key permissions (skipped on Windows — chmod not supported)
try {
  for (const svc of SERVICES) {
    chmodSync(join(certDir, `${svc}.key`), 0o600);
  }
  chmodSync(join(certDir, 'ca.key'), 0o600);
} catch {
  console.warn('[cert-gen] WARNING: Could not set key file permissions (chmod not supported on this platform).');
}

console.log('');
console.log(`[cert-gen] Done! Certificates generated in ${certDir}/`);
console.log('[cert-gen] IMPORTANT: These are self-signed certificates for development.');
console.log('[cert-gen] Replace with proper CA-signed certificates for production.');
console.log('');
console.log('Generated files:');

const allFiles = [
  'ca.key', 'ca.crt',
  ...SERVICES.flatMap(svc => [`${svc}.key`, `${svc}.crt`]),
];
for (const f of allFiles) {
  console.log(`  ${join(certDir, f)}`);
}
