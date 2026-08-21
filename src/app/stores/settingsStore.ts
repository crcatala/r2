import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * User preferences for bucket sync behavior. Persisted via zustand/persist
 * (localStorage), mirroring themeStore. Defaults preserve today's behavior
 * (auto-sync on bucket switch, 60s freshness window, 60s folder browse TTL).
 */

export type AutoSyncMode = 'on-switch' | 'periodic' | 'off';

/** Freshness window choices for "skip auto sync if recently synced" (seconds). */
export const FRESHNESS_WINDOW_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
] as const;

/** Folder browse TTL choices: how stale a partial-cache prefix can be before
 * the folder re-lists from the network (0 = always hit the network). */
export const FOLDER_TTL_OPTIONS = [
  { value: 0, label: 'Always refresh' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
] as const;

/** Periodic auto-sync interval choices (minutes). */
export const PERIOD_OPTIONS = [
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
] as const;

export const DEFAULT_AUTO_SYNC_MODE: AutoSyncMode = 'on-switch';
export const DEFAULT_FRESHNESS_SECS = 60;
export const DEFAULT_FOLDER_TTL_SECS = 60;
export const DEFAULT_AUTO_SYNC_PERIOD_MIN = 15;

/**
 * Per-bucket sync override (r2-c6gg). Keyed by "<provider>:<accountId>:<bucket>".
 * Every field optional — unset fields fall back to the global defaults.
 */
export interface BucketSyncOverride {
  /** Override of the global auto-sync mode. */
  autoSyncMode?: AutoSyncMode;
  /** Override of the global freshness window (seconds). */
  freshnessSecs?: number;
  /** Override of the global periodic interval (minutes). */
  periodicMin?: number;
}

export type BucketKey = `${string}:${string}:${string}`;

export function makeBucketKey(provider: string, accountId: string, bucket: string): BucketKey {
  return `${provider}:${accountId}:${bucket}`;
}

export interface ResolvedSyncSettings {
  mode: AutoSyncMode;
  freshnessSecs: number;
  periodMin: number;
}

/**
 * Resolve effective sync settings for one bucket: the per-bucket override
 * wins field-by-field, the global settings fill the rest. Pure — no store
 * access — so both useFilesSync and unit tests share it.
 */
export function resolveBucketSyncSettings(
  bucketKey: BucketKey | null,
  overrides: Record<string, BucketSyncOverride>,
  global: { autoSyncMode: AutoSyncMode; autoSyncFreshnessSecs: number; autoSyncPeriodMin: number }
): ResolvedSyncSettings {
  const override = bucketKey ? overrides[bucketKey] : undefined;
  return {
    mode: override?.autoSyncMode ?? global.autoSyncMode,
    freshnessSecs: override?.freshnessSecs ?? global.autoSyncFreshnessSecs,
    periodMin: override?.periodicMin ?? global.autoSyncPeriodMin,
  };
}

export interface SyncSettingsState {
  /** When to auto-run the full-bucket background sync. */
  autoSyncMode: AutoSyncMode;
  /**
   * Skip the auto sync when the bucket's last full sync falls within this
   * window (seconds). Consulted for the initial start in 'on-switch' and
   * 'periodic' modes.
   */
  autoSyncFreshnessSecs: number;
  /** Periodic auto-sync interval (minutes), only in 'periodic' mode. */
  autoSyncPeriodMin: number;
  /**
   * Folder browse TTL (seconds): how stale a partial-cache prefix may be
   * before list_prefix re-lists it from the network. 0 = always network.
   * Only consulted before the bucket's first full sync — after a full sync
   * the cache is authoritative.
   */
  folderCacheTtlSecs: number;
  /** Per-bucket overrides keyed "<provider>:<accountId>:<bucket>". */
  bucketOverrides: Record<string, BucketSyncOverride>;

  setAutoSyncMode: (mode: AutoSyncMode) => void;
  setAutoSyncFreshnessSecs: (secs: number) => void;
  setAutoSyncPeriodMin: (min: number) => void;
  setFolderCacheTtlSecs: (secs: number) => void;
  setBucketOverride: (key: BucketKey, override: BucketSyncOverride) => void;
  removeBucketOverride: (key: BucketKey) => void;
}

/**
 * Pure freshness-gate decision, shared by useFilesSync and unit tests.
 * A bucket fully synced within `freshnessSecs` (or never synced, i.e. no
 * timestamp) triggers an auto sync; a fresh full sync is authoritative, so
 * re-listing it immediately gains nothing. Only 'off' mode always skips —
 * 'periodic' follows the same window for its *initial* start (r2-knw5); the
 * periodic re-run itself is driven by the interval, not this gate.
 */
export function shouldAutoSync(params: {
  mode: AutoSyncMode;
  lastSyncMs: number | null;
  freshnessSecs: number;
  nowMs: number;
}): boolean {
  const { mode, lastSyncMs, freshnessSecs, nowMs } = params;
  if (mode === 'off') return false;
  if (lastSyncMs == null) return true;
  return nowMs - lastSyncMs >= freshnessSecs * 1000;
}

/**
 * Full "should the background sync start now" decision, shared by useFilesSync
 * and unit tests.
 *
 * Normal gate: `shouldAutoSync` (mode + freshness window).
 *
 * Bootstrap: a bucket that has *never* been fully synced gets one full sync on
 * its first view even when the GLOBAL auto-sync mode is Off — otherwise a
 * fresh connection with Off shows only a TTL-bounded lazy browse with no
 * background catalog until the user finds the manual "Sync now". An explicit
 * per-bucket "Never auto-sync" override still wins over the bootstrap.
 */
export function shouldStartBackgroundSync(params: {
  mode: AutoSyncMode;
  lastSyncMs: number | null;
  freshnessSecs: number;
  nowMs: number;
  /** Global autoSyncMode is 'off' (used to detect the bootstrap case). */
  globalAutoSyncOff: boolean;
  /** The bucket itself has an explicit 'off' override. */
  explicitlyOptedOut: boolean;
}): boolean {
  const { mode, lastSyncMs, freshnessSecs, nowMs, globalAutoSyncOff, explicitlyOptedOut } = params;
  if (shouldAutoSync({ mode, lastSyncMs, freshnessSecs, nowMs })) return true;
  if (lastSyncMs == null && globalAutoSyncOff && !explicitlyOptedOut) return true;
  return false;
}

export const useSyncSettingsStore = create<SyncSettingsState>()(
  persist(
    (set) => ({
      autoSyncMode: DEFAULT_AUTO_SYNC_MODE,
      autoSyncFreshnessSecs: DEFAULT_FRESHNESS_SECS,
      autoSyncPeriodMin: DEFAULT_AUTO_SYNC_PERIOD_MIN,
      folderCacheTtlSecs: DEFAULT_FOLDER_TTL_SECS,
      bucketOverrides: {},

      setAutoSyncMode: (autoSyncMode) => set({ autoSyncMode }),
      setAutoSyncFreshnessSecs: (autoSyncFreshnessSecs) => set({ autoSyncFreshnessSecs }),
      setAutoSyncPeriodMin: (autoSyncPeriodMin) => set({ autoSyncPeriodMin }),
      setFolderCacheTtlSecs: (folderCacheTtlSecs) => set({ folderCacheTtlSecs }),
      setBucketOverride: (key, override) =>
        set((state) => ({
          bucketOverrides: { ...state.bucketOverrides, [key]: override },
        })),
      removeBucketOverride: (key) =>
        set((state) => {
          const { [key]: _removed, ...rest } = state.bucketOverrides;
          return { bucketOverrides: rest };
        }),
    }),
    {
      name: 'sync-settings-storage',
      version: 2,
      // Explicit storage getter: persist's default is window.localStorage,
      // which doesn't exist outside a browser (tests/SSR). Resolving the
      // bare global keeps the app working everywhere with the same behavior.
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        const incoming = (persistedState ?? {}) as Partial<SyncSettingsState>;
        if (version < 2) {
          // v1 → v2: added periodic mode + interval, folder browse TTL, and
          // per-bucket overrides. Merge defaults so older payloads load
          // without crashing; newer fields keep their persisted value when
          // available.
          return {
            autoSyncMode: incoming.autoSyncMode ?? DEFAULT_AUTO_SYNC_MODE,
            autoSyncFreshnessSecs: incoming.autoSyncFreshnessSecs ?? DEFAULT_FRESHNESS_SECS,
            autoSyncPeriodMin: incoming.autoSyncPeriodMin ?? DEFAULT_AUTO_SYNC_PERIOD_MIN,
            folderCacheTtlSecs: incoming.folderCacheTtlSecs ?? DEFAULT_FOLDER_TTL_SECS,
            bucketOverrides: incoming.bucketOverrides ?? {},
          } as SyncSettingsState;
        }
        return incoming as SyncSettingsState;
      },
    }
  )
);
