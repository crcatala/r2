---
id: r2-pkmv
status: closed
deps: [r2-vq87, r2-d99z]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 1
assignee: cc-vps
parent: r2-bctw
tags: [frontend, sync, backend]
---
# Freshness gate + hydration in useFilesSync

The core fix for "switching buckets always re-lists". Today the auto-start effect in useFilesSync unconditionally cancels + restarts background sync on every bucket switch.

Changes:
- Hydrate: on config change, call getBucketSummary() once; if it returns a lastSync, setLastSyncTime(accountId, bucket, lastSync) so isSynced and the StatusBar/sidebar reflect persisted state immediately (before any sync completes).
- Gate: when deciding to auto-start background sync:
  - autoSyncMode === "off" → do not start background sync at all (still hydrate + invalidate folder queries so browsing serves from the existing cache).
  - on-switch and lastSync within autoSyncFreshnessSecs → skip start (no-op; the cache is authoritative after a full sync).
  - otherwise start as today.
- Manual refresh() must keep bypassing the gate (full bucket re-list) — route it through the shared syncBucketNow helper (r2-twoe) so there is one cancel/reset/start path.
- Keep the bgStartedRef cancel/start race guard and the existing event listeners.

## Design

Freshness window comparison uses the hydrated lastSync. Skip must not clear folder sizes or invalidate more than necessary; the existing has_full_sync path already makes folder browsing cache-only after a full sync, so skipping is safe for correctness.

## Acceptance Criteria

- Switching to a bucket synced within the window does not emit background-sync-progress / does not start a network LIST (verify via devtools/backend logs).
- Switching to a bucket synced outside the window, or never synced, still auto-syncs.
- With auto-sync Off, no background sync starts on switch; folder browsing still works from cache.
- After app restart, isSynced is true for a previously-synced bucket before any sync runs (hydration).
- refresh() still forces a full bucket sync.


## Notes

**2026-08-21T09:24:35Z**

Phase 1 implemented in PR #5 (feat/r2-bctw-sync-freshness-controls). Awaiting review/merge; close on merge.

**2026-08-21T09:54:51Z**

Review fixes applied in PR #5: unit conversion (sec->ms) at hydration + clear browse stamp for partial buckets; Sync now restricted to current bucket + added to mounted menu; forceRefreshFolder no longer empties list on failed LIST.
