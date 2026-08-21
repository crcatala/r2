---
id: r2-twoe
status: open
deps: [r2-d99z]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 1
assignee: cc-vps
parent: r2-bctw
tags: [frontend, ui, sync]
---
# Manual sync: bucket Sync now + folder force refresh

Give the user explicit control now that auto-sync can be disabled.

- r2cache.ts: add syncBucketNow(config) — cancelBackgroundSync() (race guard) → resetProgress/resetBackgroundSync on syncStore → startBackgroundSync(config). Single shared path used by useFilesSync.refresh and the UI.
- Folder force refresh: useR2Files currently hardcodes forceRefresh:false and its refresh() only invalidates queries (post-full-sync that serves from cache, so toolbar Refresh was effectively a no-op for freshness). Add forceRefreshFolder(): loadFolderItems({ forceRefresh: true }) for the current prefix and write the result into the react-query cache; keep refresh() semantics for upload/delete/move invalidations.
- page.tsx handleRefresh (toolbar / ⌘R): call forceRefreshFolder() instead of refreshSync() — fast, network-fresh current folder, does not re-list the whole bucket.
- Bucket Sync now: add a "Sync now" item to the sidebar bucket context menu (AccountSidebar getBucketContextMenu) for every bucket, building a StorageConfig from accountData/token (mirror buildMountTarget) and calling syncBucketNow. Only show for the current bucket initially if config-building for arbitrary buckets proves noisy — decide during implementation; either way it bypasses the freshness gate.

## Design

Toolbar refresh = folder-level (expectation: "show me fresh data here, fast"). Full-bucket re-list becomes an explicit action (sidebar Sync now) and the auto-sync on switch. Keyboard ⌘R keeps its "Refresh" meaning but now forces the folder network LIST.

## Acceptance Criteria

- Toolbar refresh triggers a network LIST of the current folder even after a full sync (from_cache:false in list_prefix result) and updates the view.
- Sidebar bucket menu has Sync now; clicking starts a background sync that bypasses the freshness window and reports via existing progress events.
- Upload/delete/move invalidations are unchanged (cache-friendly refresh()).
- Manual sync works with auto-sync Off.


## Notes

**2026-08-21T09:24:35Z**

Phase 1 implemented in PR #5 (feat/r2-bctw-sync-freshness-controls). Awaiting review/merge; close on merge.

**2026-08-21T09:54:51Z**

Review fixes applied in PR #5: unit conversion (sec->ms) at hydration + clear browse stamp for partial buckets; Sync now restricted to current bucket + added to mounted menu; forceRefreshFolder no longer empties list on failed LIST.
