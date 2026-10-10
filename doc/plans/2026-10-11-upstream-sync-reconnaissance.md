# Paperclip Upstream Sync Reconnaissance & Publication (2026-10-11)

## 1. Overview
- **Execution Date**: 2026-10-11
- **Upstream Source**: `paperclipai/paperclip:master` (`9ba5569030cc4f37e53906d19e13778c81c99ecc`)
- **Fork Remote**: `phuongvm/paperclip:master` (`origin/master`)
- **Previous Remote SHA**: `4b28591684e954f94b46f8dd8e8e962eee79c87a`
- **Candidate Merge SHA**: `dc42f578821b8b5415c87aa75704731a7d65f063`
- **Ingested Commits**: 29 commits from upstream
- **Status**: Reconciled, verified across all gates, and published to `origin/master`.

---

## 2. Invariant Preservation Matrix Verification
All 5 invariants were verified against the candidate merge:

| Invariant ID | Target Subsystem / Files | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **PAPERCLIP-INV-1** | `server/src/config.ts`<br>`packages/shared/src/constants.ts` | **PASS** | Loopback binding contracts for local trusted mode and Better-Auth proxy trust configuration preserved. |
| **PAPERCLIP-INV-2** | `packages/db/src/migrations/`<br>`packages/db/drizzle.config.ts` | **PASS** | `pnpm --filter @paperclipai/db run check:migrations` passed. Migration safety verified with 20 historical findings covered by baseline. |
| **PAPERCLIP-INV-3** | `packages/adapters/gemini-local/` | **PASS** | Gemini CLI adapter configuration (`--sandbox=none`) and message stream parser preserved. |
| **PAPERCLIP-INV-4** | `services/paperclip-env.cmd`<br>`services/start-paperclip.cmd` | **PASS** | Windows execution environment scripts and port contracts intact. |
| **PAPERCLIP-INV-5** | `packages/shared/src/constants.ts`<br>`ui/src/adapters/adapter-display-registry.ts`<br>`ui/src/components/OnboardingWizard.tsx` | **PASS** | Hermes adapter registration (`hermes_local`) and onboarding flow preserved without Codex subscription redirection. |

---

## 3. Verification Gates
- **Workspace Typecheck**: All 35 TypeScript packages passed (`pnpm -r typecheck`).
- **Rust Runner Core**: Format and cargo check passed (`cargo check --manifest-path runner/Cargo.toml --locked --workspace`).
- **Workspace Production Build**: All packages built successfully (`pnpm -r --workspace-concurrency=1 build`), including:
  - `@paperclipai/shared`
  - `@paperclipai/db`
  - `@paperclipai/paperclip-eval-kernel`
  - `@paperclipai/paperclip-runner` (release binary compiled)
  - `@paperclipai/ui` (Vite production bundle generated without errors)
  - `paperclipai` (CLI bundled via esbuild)

---

## 4. Script Hardening & Operational Diagnostics

### Git Push Crash (-1073741819 / 0xC0000005) Root Cause & Fix
- **Symptom**: During Autonomous Publication in `daily-sync-watchdog.ps1`, `git push origin sync/upstream-master-daily:master` failed with exit code `-1073741819` (Windows `STATUS_ACCESS_VIOLATION`).
- **Root Cause**: Phase 4 sanitized `$env:PATH` by filtering out `[\\/]usr[\\/]bin` to prevent POSIX shims from masking native Windows build failures. However, Git's bundled OpenSSH binary lives in `C:\Program Files\Git\usr\bin\ssh.exe`. Stripping `usr/bin` forced Git to fall back to `C:\Windows\System32\OpenSSH\ssh.exe`, which suffered access violations when invoked under the child process tree with tilde paths. Furthermore, `$env:PATH` was not restored after the build gate.
- **Remediation**:
  1. Preserved `$OrigPath = $env:PATH` before sanitization and restored it immediately after Phase 4 build checks completed.
  2. Explicitly pointed `$env:GIT_SSH_COMMAND` to `C:\Program Files\Git\usr\bin\ssh.exe` with the fully-qualified Windows key path `C:/Users/phuong/.ssh/id_rsa_phuongvm` and `IdentitiesOnly=yes`.
  3. Wrapped `git push` in a 3-attempt retry loop with backoff.

---

## 5. Live Cutover Instructions for Commander

To update the running Paperclip service instance to `dc42f5788`, run in PowerShell:
```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -File "O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1" -AutoRestart
```
