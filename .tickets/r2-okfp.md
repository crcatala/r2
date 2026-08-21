---
id: r2-okfp
status: closed
deps: []
links: []
created: 2026-08-17T14:24:38Z
type: bug
priority: 1
assignee: cc-vps
tags: [mounts, macos, backend, ui]
---
# Reconcile externally unmounted bucket mounts

## Problem

When a bucket mounted by the app is manually unmounted through macOS/Finder/Disk Utility, the OS mount disappears but the app continues to report the bucket as mounted. The sidebar context menu remains limited to **Reveal in Finder** and **Unmount**, so the user cannot reopen the mount modal or remount the bucket. Clicking **Unmount** fails because macOS correctly reports that the path is not mounted.

## Investigation findings

- `MountManager` keeps active mounts only in an in-memory `HashMap` (`src-tauri/src/mount/manager.rs`).
- `MountManager::list()` returns that registry verbatim; it does not verify the OS mount still exists. `list_mounts` therefore returns stale records after an external unmount.
- The frontend store (`src/app/stores/mountStore.ts`) uses `list_mounts` and `mount-changed` as the source of truth. Any listed entry is treated as mounted.
- `AccountSidebar` (`src/app/components/AccountSidebar.tsx`) switches the bucket menu from **Mount as local drive** to **Reveal in Finder** / **Unmount** whenever `findMount` returns an entry.
- `MountManager::unmount()` runs the OS unmount command before removing the entry. If the path was manually unmounted, the command fails and the stale entry remains registered.
- A stale registry entry also prevents remounting at that path because `ensure_path_available()` detects it as a conflict.

This is expected to affect any platform where users can unmount outside the app, but is immediately reproducible on macOS.

## Design

## Proposed fix

Make the backend reconcile its registry against the operating system rather than treating the in-memory registry as authoritative.

1. Add a platform-specific `is_mounted(target)` check. On macOS, prefer a native mount-table API (`getmntinfo`/`statfs`) over parsing command output; provide equivalent implementations for Linux/Windows as appropriate.
2. Add a `MountManager` reconciliation method that detects registered paths no longer mounted by the OS and removes their `ActiveMount` entries. During cleanup, abort the NFS server and flusher and preserve staging data until its existing data-safety handling has completed.
3. Reconcile before `list_mounts` returns results, and emit `mount-changed` when reconciliation changes the set so the UI is corrected automatically.
4. In `unmount()`, if the OS says the target is already unmounted, treat that as successful stale-state cleanup: remove and stop the matching registry entry instead of returning an error. Do not mask genuine unmount failures such as a busy mount.
5. Ensure the frontend refreshes mount state after window focus/visibility regain or at a modest interval while mounts exist, because a native unmount has no app-originated Tauri event. Backend reconciliation on an explicit refresh is the critical behavior; polling is only what makes correction prompt without another UI action.
6. Add a regression path so a stale entry no longer hides **Mount as local drive** or prevents remounting.

## Notes / risks

External unmount of a writable NFS mount can leave client-side writes in flight. Cleanup must retain staged files and preserve the existing drain/error behavior; it must not blindly delete staging directories.

## Acceptance Criteria

- A bucket manually unmounted in macOS is removed from the app mount list on the next reconciliation/refresh.
- The sidebar changes back to **Mount as local drive** and the user can remount the bucket.
- Selecting app **Unmount** after a native unmount cleans up stale app state rather than leaving it stuck.
- A real mounted-but-busy mount still reports an unmount failure and stays mounted in the UI.
- Reconciliation stops server/flusher resources for stale mounts and does not delete recoverable staged writable data.
- Unit tests cover stale-mount detection/reconciliation and frontend state/menu behavior; macOS-specific behavior is manually verified on a Mac.

