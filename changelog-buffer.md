### Fixed — T-2-02
- fix(scripts): replace `gen-certs.sh` with cross-platform `gen-certs.mjs`; generates CA + 5 per-service certs with SANs (no openssl bash dependency for Node users)
- fix(scripts): add SUPERSEDED comment to `scripts/gen-certs.sh`

### Fixed — T-2-03
- fix(docs): add per-variable Linux/macOS/Windows path examples to `.env.example` for AUDIT_DATA_DIR, VAULT_DATA_DIR, MEMORY_DATA_DIR, SKILLS_REGISTRY_PATH, MARKETPLACE_REGISTRY_PATH

### Refactored — T-2-06
- refactor(gateway): extract OTel hooks into registerOtelHooks() — TD-01 (`@tessera/gateway`)

### Added — T-4-01
- feat(gateway): role claim in HMAC token (4-part format: userId.role.ts.sig); `requireRole("admin")` guard on rotate-key, backup restore, and quota PUT routes; token refresh preserves role; CLI `tessera token generate -r admin` (`@tessera/gateway`, `@tessera/cli`)
