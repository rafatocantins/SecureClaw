#!/usr/bin/env node
// gen-certs.mjs — Generate an RSA key pair for local gRPC mTLS (dev only).
// Cross-platform: works on Linux, macOS, and Windows without openssl CLI.
// Replaces the legacy bash-only gen-certs.sh.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const certsDir = join(__dirname, '../certs');
mkdirSync(certsDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(join(certsDir, 'server.key'), privateKey);
writeFileSync(join(certsDir, 'server.crt'), publicKey);
console.log('Generated certs to ' + certsDir);
