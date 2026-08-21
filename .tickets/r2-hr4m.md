---
id: r2-hr4m
status: open
deps: []
links: []
created: 2026-08-21T13:01:07Z
type: task
priority: 4
assignee: cc-vps
tags: [db, tech-debt, backend]
---
# DB migration convention: replace DROP-based schema changes with PRAGMA user_version

Follow-up from fix/restart-wipes-sync-cache (PR #8). The file_cache DROP-on-startup bug (see 04aad37) is fixed, but the repo has no migration mechanism. Known residual gap, deferred: a DB created before the 2026-01-02 schema change (cached_files without parent_path/name columns; source-only builds Dec 2025, no releases exist) would fail parent_path lookups under the new idempotent SQL. Population ~zero today. Do when the schema next changes or the app ships its first release: introduce PRAGMA user_version + a proper migrate() that only runs once per version, with a backfill path for the pre-04aad37 schema.

