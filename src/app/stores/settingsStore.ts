import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * User preferences for bucket sync behavior. Persisted via zustand/persist
 * (localStorage), mirroring themeStore. Defaults preserve today's behavior
 * (auto-sync on bucket switch, 60s freshness window).
 */

export type AutoSyncMode = 'on-switch' | 'off';

/** Freshness window choices for "skip auto sync if recently synced" (seconds). */
export const FRESHNESS_WINDOW_OPTIONS = [
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 900, label: '15 minutes' },
] as const;

export const DEFAULT_AUTO_SYNC_MODE: AutoSyncMode = 'on-switch';
export const DEFAULT_FRESHNESS_SECS = 60;

export interface SyncSettingsState {
  /** When to auto-run the full-bucket background sync. */
  autoSyncMode: AutoSyncMode;
  /**
   * Skip the auto sync on switch when the bucket's last full sync falls
   * within this window (seconds). Only consulted in 'on-switch' mode.
   */
  autoSyncFreshnessSecs: number;

  setAutoSyncMode: (mode: AutoSyncMode) => void;
  setAutoSyncFreshnessSecs: (secs: number) => void;
}

/**
 * Pure freshness-gate decision, shared by useFilesSync and unit tests.
 * A bucket fully synced within `freshnessSecs` (or never synced, i.e. no
 * timestamp) triggers an auto sync; a fresh full sync is authoritative, so
 * re-listing it immediately gains nothing.
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

export const useSyncSettingsStore = create<SyncSettingsState>()(
  persist(
    (set) => ({
      autoSyncMode: DEFAULT_AUTO_SYNC_MODE,
      autoSyncFreshnessSecs: DEFAULT_FRESHNESS_SECS,

      setAutoSyncMode: (autoSyncMode) => set({ autoSyncMode }),
      setAutoSyncFreshnessSecs: (autoSyncFreshnessSecs) => set({ autoSyncFreshnessSecs }),
    }),
    {
      name: 'sync-settings-storage',
      version: 1,
      // Explicit storage getter: persist's default is window.localStorage,
      // which doesn't exist outside a browser (tests/SSR). Resolving the
      // bare global keeps the app working everywhere with the same behavior.
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        const incoming = (persistedState ?? {}) as Partial<SyncSettingsState>;
        if (version < 1) {
          // Only reached if a future version bumps the schema; merge defaults
          // so older payloads load without crashing.
          return {
            autoSyncMode: incoming.autoSyncMode ?? DEFAULT_AUTO_SYNC_MODE,
            autoSyncFreshnessSecs: incoming.autoSyncFreshnessSecs ?? DEFAULT_FRESHNESS_SECS,
          } as SyncSettingsState;
        }
        return incoming as SyncSettingsState;
      },
    }
  )
);
