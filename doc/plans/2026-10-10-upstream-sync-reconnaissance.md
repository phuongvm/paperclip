# Paperclip Upstream Sync Reconnaissance & Cutover Hardening (2026-10-10)

## 1. Overview
- **Execution Date**: 2026-10-10
- **Upstream Source**: `paperclipai/paperclip:master`
- **Fork Remote**: `phuongvm/paperclip:master` (`origin/master`)
- **Target Remote SHA**: `020208c3d93f17cb4f792a5694e9649c8876ebd6`
- **Current Live Base SHA**: `9f15c00b0f42ebbfec30e037fad72bbb14105584` (behind `origin/master` by 86 commits)
- **Status**: Reconciled & Pushed to `origin/master`. Live cutover script hardened with fail-closed git lock detection and verified.

---

## 2. Live Cutover Incident & Root Cause Analysis (RCA)

### Incident Description
During automated or manual execution of `apply-live-paperclip-cutover.ps1`, Step 1 reported:
```text
Updating 9f15c00b0..020208c3d
error: Unable to create 'O:/workspaces/.git/modules/oss/paperclip/index.lock': File exists.
Another git process seems to be running in this repository, or the lock file may be stale
  ✓ [PASS] Step 1 Complete: Live repository synchronized.
```
The script subsequently pre-warmed dependencies and restarted the service on port 3101, but the running instance remained on the old commit (`9f15c00b0`).

### Root Cause
1. **Stale Git Index Lock**: An orphaned `index.lock` file (`O:\workspaces\.git\modules\oss\paperclip\index.lock`, 0 bytes) created at `10/09/2026 14:41:25` (>18 hours old) prevented git operations from acquiring the index. File handle checks confirmed no active processes held the lock.
2. **Missing Native Exit Code Checks**: `& git merge --ff-only origin/master` in PowerShell did not trigger `$ErrorActionPreference = "Stop"` because native command non-zero exits are not treated as terminating PowerShell errors unless `$LASTEXITCODE` is explicitly asserted.
3. **Missing Post-Merge SHA Verification**: The script did not verify that `git rev-parse HEAD` matched `origin/master` after attempting the fast-forward merge.

---

## 3. Script Hardening & Enhancements

### A. `apply-live-paperclip-cutover.ps1`
Location: `O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1`
1. **Pre-Flight Git Lock Inspection**:
   - Resolves git directory via `git rev-parse --git-dir` (accounting for submodules and external worktrees).
   - Inspects `index.lock` existence before executing git commands.
   - Tests file handle concurrency via `[System.IO.File]::Open` to differentiate active locks from stale locks.
   - Halts immediately (`throw`) with explicit diagnosis, file age, and actionable remediation steps.
2. **`-ForceRemoveStaleLock` Switch**:
   - Added `[switch]$ForceRemoveStaleLock` to automatically clear unlocked stale lock files older than 2 minutes when explicitly authorized.
3. **Strict Post-Merge Assertion**:
   - Asserts `$LASTEXITCODE -eq 0` on `git fetch` and `git merge --ff-only`.
   - Re-checks `git rev-parse HEAD` against `origin/master` and halts immediately if SHA mismatch is detected.

### B. `daily-sync-watchdog.ps1`
Location: `O:\workspaces\.agents\skills\paperclip-upstream-sync\scripts\daily-sync-watchdog.ps1`
- Added `$LASTEXITCODE` check after calling `$CutoverScript` during `-AutoCutover` runs to guarantee fail-closed execution.

### C. `paperclip-upstream-sync` Skill
Location: `O:\workspaces\.agents\skills\paperclip-upstream-sync\SKILL.md`
- Version bumped to `1.5.1`.
- Added operational pitfall: *Detect and fail-closed on git index.lock during live cutovers*.

---

## 4. Invariant Preservation Matrix Verification
| Invariant ID | Target Subsystem / Files | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **PAPERCLIP-INV-1** | `server/src/config.ts`<br>`packages/shared/src/constants.ts` | **PASS** | DeploymentMode binding and loopback contracts preserved. |
| **PAPERCLIP-INV-2** | `packages/db/src/migrations/`<br>`packages/db/drizzle.config.ts` | **PASS** | Verified migrations and database backup integrity. |
| **PAPERCLIP-INV-3** | `packages/adapters/gemini-local/` | **PASS** | `--sandbox=none` execution contract preserved. |
| **PAPERCLIP-INV-4** | `services/paperclip-env.cmd`<br>`services/start-paperclip.cmd` | **PASS** | Launch scripts and runtime environment contracts untouched. |
| **PAPERCLIP-INV-5** | `packages/shared/src/constants.ts`<br>`ui/src/adapters/adapter-display-registry.ts`<br>`ui/src/components/OnboardingWizard.tsx` | **PASS** | Hermes adapter registration and local CLI display flow preserved. |

---

## 5. Live Cutover Commands for Commander

To resolve the stale lock and bring live services up to `020208c3d`:

**Option A (Manual Stale Lock Removal - Recommended)**:
```powershell
# 1. Remove stale lock file
Remove-Item -Force 'O:\workspaces\.git\modules\oss\paperclip\index.lock'

# 2. Execute cutover and automated restart
& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -File "O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1" -AutoRestart
```

**Option B (Automated Stale Lock Removal via New Flag)**:
```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -File "O:\workspaces\_config\agent4070\hermes\services\apply-live-paperclip-cutover.ps1" -ForceRemoveStaleLock -AutoRestart
```
