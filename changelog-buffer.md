### Fixed — T-2-02 + T-2-03
- chore(dx): migrate gen-certs.sh to cross-platform gen-certs.mjs using node:crypto (ISSUE-DX-002)
- chore(dx): add Windows path examples and os.tmpdir() notes to .env.example (ISSUE-DX-003)
- chore(dx): add bash-requirement comments to start-dev.sh and build-tools.sh

### Refactored — T-2-06
- refactor(gateway): extract OTel hooks into registerOtelHooks() — TD-01 (`@tessera/gateway`)
