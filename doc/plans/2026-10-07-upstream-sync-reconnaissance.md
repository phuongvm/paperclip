# Paperclip Upstream Sync Reconnaissance & Audit (2026-10-07)

## 1. Overview
- **Execution Date**: 2026-10-07
- **Upstream Source**: `paperclipai/paperclip:master` (`5c15be37155c51d3a9e6684631afdb51c862a938`)
- **Fork Remote**: `phuongvm/paperclip:master` (`origin/master`)
- **Reconciliation Candidate SHA**: `d68700b9c85bfe96eb63465416d33adf94ee530e`
- **Reconciled Commit Count**: 49 commits ahead of fork base `c7bdba67a71d8f6f6b8f3aff2a9bb9c36c0dba86`
- **Status**: Merged, Conflict Reconciled, Fully Verified (Typecheck + Build + Runner Binary), Pushed to `origin/master`.

---

## 2. Reconciled Conflict & Invariants
- **Conflict File**: `ui/src/components/AdapterLoginChrome.tsx`
- **Resolution**:
  - Reconciled upstream browser code submission state (`browserCode`, `submitting`) and browser sign-in flow.
  - Preserved **PAPERCLIP-INV-5**: Hermes adapter display label and onboarding provider mapping (`adapterType === "hermes_local" ? "Hermes" : "Codex CLI"`).

---

## 3. Invariant Preservation Matrix Verification
| Invariant ID | Subsystem / Files | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **PAPERCLIP-INV-1** | `server/src/config.ts`, `packages/shared/src/constants.ts` | **PASS** | DeploymentMode binding and loopback contracts preserved. |
| **PAPERCLIP-INV-2** | `packages/db/src/migrations/`, `packages/db/drizzle.config.ts` | **PASS** | `pnpm --filter @paperclipai/db run check:migrations` passed (20 historical findings covered by baseline). |
| **PAPERCLIP-INV-3** | `packages/adapters/gemini-local/` | **PASS** | `--sandbox=none` execution contract preserved. |
| **PAPERCLIP-INV-4** | `services/paperclip-env.cmd`, `services/start-paperclip.cmd` | **PASS** | Windows launch environment and port 3101 isolation preserved. |
| **PAPERCLIP-INV-5** | `packages/shared/src/constants.ts`, `ui/src/adapters/adapter-display-registry.ts`, `ui/src/components/AdapterLoginChrome.tsx` | **PASS** | Hermes adapter registration, UI login flow, and display labels preserved. |

---

## 4. Verification Gates
- **Static Typecheck**: `pnpm -r typecheck` passed cleanly across 35 of 36 workspace packages (1 excluded).
- **Production Build**: `pnpm build` passed cleanly across all workspace packages including `ui` (Vite) and `server`.
- **Rust Runner**: `paperclip-runner-core` and `paperclip-runnerd` compiled cleanly in release profile.
- **Remote Push**: `git push origin sync/upstream-master-daily:master` verified via `git ls-remote` (`d68700b9c85bfe96eb63465416d33adf94ee530e`).

---

## 5. Cutover Action
When ready to cut over the live production daemon, execute in PowerShell:
```powershell
& 'O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1'
```
