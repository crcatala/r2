---
id: r2-c6gg
status: open
deps: [r2-d99z, r2-knw5]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 3
assignee: cc-vps
parent: r2-bctw
tags: [frontend, sync, phase-2]
---
# Per-bucket sync overrides

Phase 2. Let specific buckets opt out of auto-sync or use a custom freshness window (e.g. a giant archive bucket that should never auto-list).

- settingsStore: per-bucket record keyed "<provider>:<accountId>:<bucket>" with override { autoSyncMode?, freshnessSecs?, periodicMin? }.
- useFilesSync gate resolves override before global settings.
- Settings Sync tab: "per-bucket overrides" section listing saved buckets with toggles; sidebar bucket menu gains "Sync settings…".
- Keep the global defaults as fallback.

## Acceptance Criteria

- A bucket with "never auto-sync" is skipped by on-switch and periodic modes.
- Overrides persist and survive restart; UI to manage them exists; defaults unchanged for other buckets.

