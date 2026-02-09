# Git Sync

## Overview

The git sync module (`src/git/gitSync.ts`) handles bidirectional synchronization between the container's local vault and the remote git repository.

## Initialization

On startup, `initializeVault()` is called:
1. If `/vault/.git` exists → `git pull --rebase`
2. Otherwise → `git clone --branch <branch> --single-branch <repo> /vault`
3. Sets `user.name` and `user.email` for commits

## Pull Sync (Read)

- **On startup**: Automatic via `initializeVault()`
- **Periodic**: `startPeriodicSync()` runs `git pull --rebase` at the configured interval (`GIT_SYNC_INTERVAL_SECONDS`, default 300s)
- Setting interval to `0` disables periodic sync

## Push Sync (Write) — Debounced Auto-Sync

Write operations (write, edit, delete, rename) no longer commit and push synchronously. Instead, they call `scheduleSync()` from `src/git/debouncedSync.ts`, which uses a debounce mechanism:

1. Each write tool schedules a sync with a description (e.g., `MCP: write notes/daily.md`)
2. A debounce timer starts (default: 10 seconds, configurable via `GIT_DEBOUNCE_SYNC_DELAY_SECONDS`)
3. If another write arrives during the debounce window, the timer resets and the new description is added to the batch
4. When the timer fires (no new writes for the configured delay), all accumulated changes are committed and pushed in a single git operation

### Git commit flow (when debounce fires)
1. `git add .`
2. `git status --porcelain` to check if there are changes
3. `git commit -m "<message>"` — single change uses its original message; multiple changes produce `MCP: N operations — <descriptions>`
4. `git pull --rebase` (pre-push merge)
5. `git push origin <branch>`

### Concurrency
If a sync is already in progress when the debounce timer fires, the new sync is queued and executes after the current one completes.

### Graceful shutdown
On server shutdown, `flushDebouncedSync()` is called to immediately commit and push any pending changes before the process exits.

## Conflict Handling

- Uses `--rebase` on pull to minimize merge commits
- If the pre-push pull fails, the push is still attempted
- On conflict, the git operation will fail with a `GitSyncError` and the tool will return an error to the client

## Timeouts

All git operations have a 30-second timeout (`GIT_TIMEOUT_MS`).

## Security

- Uses `child_process.execFile` (not `exec`) to avoid shell injection
- Git commands receive arguments as arrays, never interpolated into shell strings

## Sync Status

- `getLastSyncTimestamp()` returns the time of the last successful sync
- Exposed to clients via the `get_vault_info` tool
