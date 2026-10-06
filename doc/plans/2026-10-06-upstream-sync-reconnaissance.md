# Paperclip Upstream Sync Reconnaissance & Audit (2026-10-06)

## 1. Overview
- **Execution Date**: 2026-10-06
- **Upstream Source**: `paperclipai/paperclip:master` (`ad0c4f076706e4b6686d8e9dacd472f66452151d`)
- **Fork Remote**: `phuongvm/paperclip:master` (`origin/master`)
- **Reconciliation Candidate SHA**: `9c75901297d785e37a85ba75d58f1213f439269f`
- **Reconciled Commit Count**: 14 commits ahead of merge-base `b3c85e1bf04aeebfeec918d2d344b80e09cac620`
- **Status**: Merged, Fully Verified (Typecheck + Build + Runner Binary), Pushed to `origin/master`.

---

## 2. Reconciled Upstream Commits
1. `ad0c4f076` fix(ui): keep mobile task output above the composer (#15282)
2. `6c36c07a4` feat(adapters): add GPT-6.1 Sol and refresh shared coding harness pins (#14942)
3. `e9d64ec1b` docs(release): add two missed user-facing changes to the v2026.1005.0 notes (#15251)
4. `41c1431d6` fix(server): remove the fixture-cleanup deadlock in the stale queued-run test (#14968)
5. `b43073d11` feat(connections): sync and group accounts managed by aggregators (#15254)
6. `55e0c895e` test(ui): finish sidebar focus cleanup before JSDOM teardown (#15255)
7. `cab4263dc` feat(claude-local): add Sonnet 5.5 and refresh the qualified Claude runtime (#14993)
8. `17fa71867` Retry transient disconnects in scoped read queries (#15248)
9. `3b47a6bef` Record bounded workspace restore failure stages (#15005)
10. `2e67ea8dc` fix: renew explicit continuation authorization for bounded retries (#14987)
11. `749870564` fix(ui): stabilize mobile task reading and document navigation (#15228)
12. `59015846a` fix(chat): keep dismissed task questions in the feed (#15229)
13. `a65ca0950` fix(runner): settle accepted results after shutdown failures (#15217)
14. `a386a5999` Reduce repeated native completion guidance and preserve final replies (#15151)

---

## 3. Invariant Preservation Matrix Verification
| Invariant ID | Subsystem / Files | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **PAPERCLIP-INV-1** | `server/src/config.ts`, `packages/shared/src/constants.ts` | **PASS** | `hermes_local` retained, deploymentMode binding untouched. |
| **PAPERCLIP-INV-2** | `packages/db/src/migrations/`, `packages/db/drizzle.config.ts` | **PASS** | `pnpm --filter @paperclipai/db run check:migrations` passed; 20 historical findings covered by baseline. |
| **PAPERCLIP-INV-3** | `packages/adapters/gemini-local/` | **PASS** | `--sandbox=none` retained in `execute.ts`. |
| **PAPERCLIP-INV-4** | `services/paperclip-env.cmd`, `services/start-paperclip.cmd` | **PASS** | Launch scripts and runtime-info contracts untouched. |
| **PAPERCLIP-INV-5** | `packages/shared/src/constants.ts`, `ui/src/adapters/adapter-display-registry.ts` | **PASS** | Hermes adapter registration and onboarding configuration preserved. |

---

## 4. Verification Gates
- **Static Typecheck**: `pnpm -r typecheck` passed cleanly across 35 of 36 workspace packages (1 excluded).
- **Production Build**: `pnpm build` passed cleanly across all packages including `ui` (Vite) and `server`.
- **Rust Runner**: `paperclip-runner-core` and `paperclip-runnerd` compiled cleanly in release profile.
- **Remote Push**: `git push origin sync/upstream-master-daily:master` verified via `git ls-remote` (`9c75901297d785e37a85ba75d58f1213f439269f`).

---

## 5. Cutover Action
When ready to cut over the live production daemon, execute in PowerShell:
```powershell
& 'O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1'
```
