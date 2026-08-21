---
id: r2-sfpf
status: open
deps: [r2-vq87, r2-d99z]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 1
assignee: cc-vps
parent: r2-bctw
tags: [frontend, ui]
---
# Last-synced display + staleness in sidebar bucket rows

Surface sync freshness where switching decisions happen — the sidebar.

- Extract useRelativeTime from StatusBar.tsx into src/app/utils/relativeTime.ts; StatusBar imports it (no behavior change).
- BucketRow (AccountSidebarRows.tsx): accept accountId prop, read useSyncStore bucketSyncTimes for "<accountId>:<bucket>", render a small relative "Synced X ago" label under the bucket name (reuse sb-bucket-* styling; keep it subtle).
- Staleness: when settings autoSyncMode === "off" and the bucket has no lastSync or it is older than 24h, render the label in amber with a "Stale" hint (tooltip explains: auto-sync off, data may not reflect remote changes). Never synced → "Not synced".
- Thread accountId through R2AccountChildren/NonR2AccountChildren BucketRow usages.

## Design

Uses the hydrated bucketSyncTimes (r2-vq87 + hydration in r2-pkmv), so times survive restarts. Staleness threshold constant (24h) defined in the new utils module.

## Acceptance Criteria

- Sidebar bucket rows show relative last-synced after a sync and after restart (hydrated).
- With auto-sync Off and a stale/never-synced bucket, the label is amber with a Stale/Not synced state and a tooltip.
- StatusBar relative time unchanged (same util).


## Notes

**2026-08-21T09:24:35Z**

Phase 1 implemented in PR #5 (feat/r2-bctw-sync-freshness-controls). Awaiting review/merge; close on merge.
