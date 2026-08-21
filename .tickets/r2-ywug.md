---
id: r2-ywug
status: open
deps: [r2-d99z, r2-twoe]
links: []
created: 2026-08-21T09:14:37Z
type: task
priority: 3
assignee: cc-vps
parent: r2-bctw
tags: [backend, sync, phase-2]
---
# Configurable folder browse TTL (backend parameterization)

Phase 2. Today STALE_THRESHOLD_SECS (60s) in lazy_sync.rs list_prefix is a hardcoded constant, and it only governs pre-full-sync browsing (after a full sync the cache is authoritative and the TTL is moot).

- Parameterize: add cache_ttl_secs: Option<i64> to LazyListInput (default 60) and use it in place of the constant; the frontend passes the setting value from settingsStore.
- Settings: replace the freshness-window-only select with a folder TTL select (0 = always hit network, 15s, 30s, 1m, 5m, 15m, 30m, 1h). Explain that it only affects partial-cache browsing (auto-sync Off or pre-first-sync).
- Wire getConnectionInput in r2cache.ts to send cache_ttl_secs.
- Rust unit tests for the parameterized threshold (fresh/stale branches).

## Acceptance Criteria

- Folder TTL is configurable and honored by list_prefix.
- TTL=0 forces a network LIST on every folder open.
- Settings UI explains when the TTL applies (partial cache only).
- Existing default 60s preserved.


## Notes

**2026-08-21T10:27:06Z**

Implemented in PR (feat/r2-phase2-sync-ttl-periodic-overrides): LazyListInput gains cache_ttl_secs (default 60, 0 = always network); list_prefix delegates the fresh/stale decision to pure should_serve_from_cache() with unit tests. Frontend: folderCacheTtlSecs setting (0/15s/30s/1m/5m/15m/30m/1h) wired through r2cache.listPrefix -> useR2Files. Full-sync authoritative path unchanged.
