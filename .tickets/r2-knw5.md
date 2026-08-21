---
id: r2-knw5
status: open
deps: [r2-d99z, r2-pkmv]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 3
assignee: cc-vps
parent: r2-bctw
tags: [frontend, sync, phase-2]
---
# Periodic auto-sync mode

Phase 2. Add a periodic auto-sync: while a bucket is selected, re-run the background sync every N minutes so remote changes are picked up without manual action.

- settingsStore: autoSyncMode gains "periodic" + autoSyncPeriodMin (default 15, options 5/15/30/60).
- useFilesSync: when mode is periodic, after the initial start schedule an interval that calls syncBucketNow(config) for the current bucket; cancel on config change/unmount; respect the freshness window for the initial start.
- Settings Sync tab: new segmented option + interval select.
- Careful with the cancel/start race (same guard as today) and with not overlapping an in-flight sync (skip tick if backgroundSync.isRunning).

## Acceptance Criteria

- In periodic mode the current bucket re-syncs on the chosen interval while selected.
- No overlapping syncs; switching buckets resets the timer; unmount/off disables it.
- Interval and mode persist across restarts.


## Notes

**2026-08-21T10:27:06Z**

Implemented in PR (feat/r2-phase2-sync-ttl-periodic-overrides): autoSyncMode gains 'periodic' + autoSyncPeriodMin (5/15/30/60, default 15). useFilesSync schedules an interval that runs syncBucketNow for the current bucket, skips ticks while backgroundSync.isRunning, resets on config/settings change. Initial start still respects the freshness window. Settings Sync tab: mode segment + interval select.
