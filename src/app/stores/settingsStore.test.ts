import { describe, expect, test, beforeEach } from 'bun:test';

// ── localStorage shim, set BEFORE the store module is imported ─────
// ESM hoists static imports above other statements, so settingsStore must
// not be statically imported here — zustand's persist middleware captures
// the storage reference when the store module is first evaluated.
const localStore: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => localStore[k] ?? null,
  setItem: (k: string, v: string) => {
    localStore[k] = v;
  },
  removeItem: (k: string) => {
    delete localStore[k];
  },
  clear: () => {
    for (const k of Object.keys(localStore)) delete localStore[k];
  },
  key: (i: number) => Object.keys(localStore)[i] ?? null,
  get length() {
    return Object.keys(localStore).length;
  },
} as unknown as Storage;

// Loaded after the shim exists (top-level await keeps the import order
// explicit and matches how the app runs in a browser).
const {
  useSyncSettingsStore,
  shouldAutoSync,
  shouldStartBackgroundSync,
  resolveBucketSyncSettings,
  makeBucketKey,
  DEFAULT_AUTO_SYNC_MODE,
  DEFAULT_FRESHNESS_SECS,
  DEFAULT_AUTO_SYNC_PERIOD_MIN,
  DEFAULT_FOLDER_TTL_SECS,
} = await import('./settingsStore');

describe('shouldAutoSync (freshness gate)', () => {
  const NOW = 1_000_000_000_000;

  test('off mode never auto-syncs, even when never synced', () => {
    expect(shouldAutoSync({ mode: 'off', lastSyncMs: null, freshnessSecs: 60, nowMs: NOW })).toBe(
      false
    );
    expect(
      shouldAutoSync({ mode: 'off', lastSyncMs: NOW - 1, freshnessSecs: 60, nowMs: NOW })
    ).toBe(false);
  });

  test('never-synced bucket auto-syncs in on-switch mode', () => {
    expect(
      shouldAutoSync({ mode: 'on-switch', lastSyncMs: null, freshnessSecs: 60, nowMs: NOW })
    ).toBe(true);
  });

  test('fresh full sync is skipped (authoritative cache)', () => {
    expect(
      shouldAutoSync({
        mode: 'on-switch',
        lastSyncMs: NOW - 30_000, // 30s ago, window 60s
        freshnessSecs: 60,
        nowMs: NOW,
      })
    ).toBe(false);
  });

  test('exactly at the window boundary is stale (re-sync)', () => {
    expect(
      shouldAutoSync({
        mode: 'on-switch',
        lastSyncMs: NOW - 60_000,
        freshnessSecs: 60,
        nowMs: NOW,
      })
    ).toBe(true);
  });

  test('older than the window auto-syncs', () => {
    expect(
      shouldAutoSync({
        mode: 'on-switch',
        lastSyncMs: NOW - 10 * 60_000,
        freshnessSecs: 60,
        nowMs: NOW,
      })
    ).toBe(true);
  });

  test('window of 0 forces a sync for any existing timestamp', () => {
    expect(
      shouldAutoSync({
        mode: 'on-switch',
        lastSyncMs: NOW - 1,
        freshnessSecs: 0,
        nowMs: NOW,
      })
    ).toBe(true);
  });

  test('a never-synced bucket bootstraps even with global auto-sync off', () => {
    // Real bootstrap: never fully synced + global Off -> one sync on first
    // view, unless the bucket has an explicit "Never auto-sync" override.
    expect(
      shouldStartBackgroundSync({
        mode: 'off',
        lastSyncMs: null,
        freshnessSecs: 60,
        nowMs: NOW,
        globalAutoSyncOff: true,
        explicitlyOptedOut: false,
      })
    ).toBe(true);
  });

  test('bootstrap never overrides an explicit per-bucket opt-out', () => {
    expect(
      shouldStartBackgroundSync({
        mode: 'off',
        lastSyncMs: null,
        freshnessSecs: 60,
        nowMs: NOW,
        globalAutoSyncOff: true,
        explicitlyOptedOut: true,
      })
    ).toBe(false);
  });

  test('bootstrap only applies to never-synced buckets', () => {
    expect(
      shouldStartBackgroundSync({
        mode: 'off',
        lastSyncMs: NOW - 1,
        freshnessSecs: 60,
        nowMs: NOW,
        globalAutoSyncOff: true,
        explicitlyOptedOut: false,
      })
    ).toBe(false);
  });

  test('bootstrap is a no-op when the gate already decided', () => {
    // on-switch + never synced already syncs via the normal gate.
    expect(
      shouldStartBackgroundSync({
        mode: 'on-switch',
        lastSyncMs: null,
        freshnessSecs: 60,
        nowMs: NOW,
        globalAutoSyncOff: false,
        explicitlyOptedOut: false,
      })
    ).toBe(true);
  });

  // r2-knw5: periodic mode gates its *initial* start by the same freshness
  // window as on-switch (the interval re-runs bypass the gate).
  test('periodic initial start respects the freshness window', () => {
    expect(
      shouldAutoSync({
        mode: 'periodic',
        lastSyncMs: NOW - 30_000,
        freshnessSecs: 60,
        nowMs: NOW,
      })
    ).toBe(false);
    expect(
      shouldAutoSync({ mode: 'periodic', lastSyncMs: NOW - 61_000, freshnessSecs: 60, nowMs: NOW })
    ).toBe(true);
    expect(
      shouldAutoSync({ mode: 'periodic', lastSyncMs: null, freshnessSecs: 60, nowMs: NOW })
    ).toBe(true);
  });
});

describe('resolveBucketSyncSettings (r2-c6gg)', () => {
  const GLOBAL = {
    autoSyncMode: 'on-switch' as const,
    autoSyncFreshnessSecs: 60,
    autoSyncPeriodMin: 15,
  };

  test('no override -> global settings fill every field', () => {
    expect(resolveBucketSyncSettings(null, {}, GLOBAL)).toEqual({
      mode: 'on-switch',
      freshnessSecs: 60,
      periodMin: 15,
    });
    expect(resolveBucketSyncSettings('r2:a:b', {}, GLOBAL)).toEqual({
      mode: 'on-switch',
      freshnessSecs: 60,
      periodMin: 15,
    });
  });

  test('override wins field-by-field, unset fields keep globals', () => {
    const resolved = resolveBucketSyncSettings(
      'r2:a:b',
      { 'r2:a:b': { autoSyncMode: 'off' } },
      GLOBAL
    );
    expect(resolved).toEqual({
      mode: 'off',
      freshnessSecs: 60,
      periodMin: 15,
    });
  });

  test('a different bucket override does not leak into this bucket', () => {
    const resolved = resolveBucketSyncSettings(
      'r2:a:other',
      { 'r2:a:b': { autoSyncMode: 'off' } },
      GLOBAL
    );
    expect(resolved.mode).toBe('on-switch');
  });

  test('full override replaces all three fields', () => {
    const resolved = resolveBucketSyncSettings(
      'minio:m:b',
      { 'minio:m:b': { autoSyncMode: 'periodic', freshnessSecs: 300, periodicMin: 60 } },
      GLOBAL
    );
    expect(resolved).toEqual({ mode: 'periodic', freshnessSecs: 300, periodMin: 60 });
  });
});

describe('makeBucketKey', () => {
  test('joins provider, account, and bucket', () => {
    expect(makeBucketKey('r2', 'acct', 'bkt')).toBe('r2:acct:bkt');
  });
});

beforeEach(() => {
  for (const k of Object.keys(localStore)) delete localStore[k];
  // Fresh store each test so persisted state from a previous test cannot leak.
  useSyncSettingsStore.setState({
    autoSyncMode: DEFAULT_AUTO_SYNC_MODE,
    autoSyncFreshnessSecs: DEFAULT_FRESHNESS_SECS,
    autoSyncPeriodMin: DEFAULT_AUTO_SYNC_PERIOD_MIN,
    folderCacheTtlSecs: DEFAULT_FOLDER_TTL_SECS,
    bucketOverrides: {},
  });
});

describe('useSyncSettingsStore', () => {
  test('defaults preserve current behavior', () => {
    const state = useSyncSettingsStore.getState();
    expect(state.autoSyncMode).toBe(DEFAULT_AUTO_SYNC_MODE);
    expect(state.autoSyncFreshnessSecs).toBe(DEFAULT_FRESHNESS_SECS);
    expect(state.autoSyncPeriodMin).toBe(DEFAULT_AUTO_SYNC_PERIOD_MIN);
    expect(state.folderCacheTtlSecs).toBe(DEFAULT_FOLDER_TTL_SECS);
    expect(state.bucketOverrides).toEqual({});
  });

  test('setters update state and persist to localStorage', () => {
    useSyncSettingsStore.getState().setAutoSyncMode('periodic');
    useSyncSettingsStore.getState().setAutoSyncFreshnessSecs(300);
    useSyncSettingsStore.getState().setAutoSyncPeriodMin(30);
    useSyncSettingsStore.getState().setFolderCacheTtlSecs(0);

    const state = useSyncSettingsStore.getState();
    expect(state.autoSyncMode).toBe('periodic');
    expect(state.autoSyncFreshnessSecs).toBe(300);
    expect(state.autoSyncPeriodMin).toBe(30);
    expect(state.folderCacheTtlSecs).toBe(0);

    const raw = globalThis.localStorage.getItem('sync-settings-storage');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({
      autoSyncMode: 'periodic',
      autoSyncFreshnessSecs: 300,
      autoSyncPeriodMin: 30,
      folderCacheTtlSecs: 0,
      bucketOverrides: {},
    });
  });

  test('bucket override set/remove round-trips through persistence', () => {
    const key = makeBucketKey('r2', 'acct', 'archive');
    useSyncSettingsStore.getState().setBucketOverride(key, { autoSyncMode: 'off' });
    expect(useSyncSettingsStore.getState().bucketOverrides[key]).toEqual({ autoSyncMode: 'off' });

    useSyncSettingsStore.getState().setBucketOverride(key, {
      autoSyncMode: 'periodic',
      periodicMin: 60,
    });
    expect(useSyncSettingsStore.getState().bucketOverrides[key]).toEqual({
      autoSyncMode: 'periodic',
      periodicMin: 60,
    });

    useSyncSettingsStore.getState().removeBucketOverride(key);
    expect(useSyncSettingsStore.getState().bucketOverrides).toEqual({});
  });

  test('v1 persisted payload migrates to v2 defaults', async () => {
    // Simulate a payload stored by the phase-1 schema (version 1).
    const v1Payload = {
      state: { autoSyncMode: 'off', autoSyncFreshnessSecs: 300 },
      version: 1,
    };
    globalThis.localStorage.setItem('sync-settings-storage', JSON.stringify(v1Payload));

    // persist.rehydrate re-runs hydration, including the schema migration.
    await useSyncSettingsStore.persist.rehydrate();
    const s = useSyncSettingsStore.getState();
    expect(s.autoSyncMode).toBe('off');
    expect(s.autoSyncFreshnessSecs).toBe(300);
    expect(s.autoSyncPeriodMin).toBe(DEFAULT_AUTO_SYNC_PERIOD_MIN);
    expect(s.folderCacheTtlSecs).toBe(DEFAULT_FOLDER_TTL_SECS);
    expect(s.bucketOverrides).toEqual({});
  });
});
