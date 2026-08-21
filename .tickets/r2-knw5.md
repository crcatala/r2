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

