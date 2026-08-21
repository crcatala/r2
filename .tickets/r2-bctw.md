---
id: r2-bctw
status: open
deps: []
links: []
created: 2026-08-21T09:14:12Z
type: epic
priority: 1
assignee: cc-vps
tags: [sync, cache, settings, ux]
---
# Sync freshness, cache controls & manual sync UX

Epic: make bucket/folder sync behavior configurable and transparent.

Problem: switching buckets always triggers a full background re-list of that bucket (no freshness check), the 60s folder TTL only governs pre-full-sync browsing, last-synced times live only in an in-memory Zustand map (lost on restart), and there is no manual per-bucket or per-folder sync action.

Phase 1 (this epics near-term scope): freshness gate on auto background sync, persisted last-sync times hydrated from sync_meta, persisted settings (auto-sync mode + freshness window), manual "Sync now" (bucket) + force-refresh (folder) controls, and last-synced/staleness display in the sidebar.

Phase 2 (documented, deferred): configurable folder browse TTL, periodic auto-sync, per-bucket overrides.

## Acceptance Criteria

Phase 1: switching to a recently-synced bucket does not re-list it; last-synced survives restart; auto-sync can be turned off with a manual Sync now path; folder refresh hits the network; sidebar shows relative last-synced with staleness. Phase 2 tickets tracked separately below.

