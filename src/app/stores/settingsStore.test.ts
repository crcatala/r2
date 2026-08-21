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
const { useSyncSettingsStore, shouldAutoSync, DEFAULT_AUTO_SYNC_MODE, DEFAULT_FRESHNESS_SECS } =
  await import('./settingsStore');

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
});

beforeEach(() => {
  for (const k of Object.keys(localStore)) delete localStore[k];
});

describe('useSyncSettingsStore', () => {
  test('defaults preserve current behavior', () => {
    const state = useSyncSettingsStore.getState();
    expect(state.autoSyncMode).toBe(DEFAULT_AUTO_SYNC_MODE);
    expect(state.autoSyncFreshnessSecs).toBe(DEFAULT_FRESHNESS_SECS);
  });

  test('setters update state and persist to localStorage', () => {
    useSyncSettingsStore.getState().setAutoSyncMode('off');
    useSyncSettingsStore.getState().setAutoSyncFreshnessSecs(300);

    expect(useSyncSettingsStore.getState().autoSyncMode).toBe('off');
    expect(useSyncSettingsStore.getState().autoSyncFreshnessSecs).toBe(300);

    const raw = globalThis.localStorage.getItem('sync-settings-storage');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).state).toEqual({
      autoSyncMode: 'off',
      autoSyncFreshnessSecs: 300,
    });
  });
});
