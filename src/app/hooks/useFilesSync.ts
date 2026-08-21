import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import {
  startBackgroundSync,
  cancelBackgroundSync,
  getBucketSummary,
  syncBucketNow,
  StorageConfig,
} from '@/app/lib/r2cache';
import { useFolderSizeStore } from '@/app/stores/folderSizeStore';
import { useSyncStore, SyncPhase } from '@/app/stores/syncStore';
import {
  useSyncSettingsStore,
  shouldStartBackgroundSync,
  resolveBucketSyncSettings,
  makeBucketKey,
} from '@/app/stores/settingsStore';

interface BackgroundSyncProgressEvent {
  objects_fetched: number;
  bytes_fetched: number;
  estimated_total: number | null;
  is_running: boolean;
  speed: number;
}

interface BackgroundSyncCompleteEvent {
  total_objects: number;
  total_bytes: number;
  cancelled: boolean;
}

/**
 * Files sync hook — now uses background deep sync instead of blocking full sync.
 *
 * The foreground lazy sync (per-folder) is handled by useR2Files directly.
 * This hook manages the background deep sync that fills in the complete dataset
 * for search, folder sizes, and accurate counts.
 *
 * Keeps the same return API (isSyncing, isSynced, lastSyncTime, refresh)
 * so page.tsx doesn't need massive changes.
 */
export function useFilesSync(config: StorageConfig | null) {
  const queryClient = useQueryClient();
  const clearSizes = useFolderSizeStore((state) => state.clearSizes);
  const bgStartedRef = useRef<string | null>(null);

  // Get per-bucket sync time
  const bucketSyncTimes = useSyncStore((state) => state.bucketSyncTimes);
  const lastSyncTime = useMemo(() => {
    if (!config?.accountId || !config?.bucket) return null;
    return useSyncStore.getState().getLastSyncTime(config.accountId, config.bucket);
  }, [config?.accountId, config?.bucket, bucketSyncTimes]);

  // Update current bucket in store when config changes
  useEffect(() => {
    useSyncStore.getState().setCurrentBucket(config?.accountId ?? null, config?.bucket ?? null);
  }, [config?.accountId, config?.bucket]);

  // Listen for background sync progress events
  useEffect(() => {
    const unlistenProgress = listen<BackgroundSyncProgressEvent>(
      'background-sync-progress',
      (event) => {
        useSyncStore.getState().setBackgroundSyncProgress({
          objectsFetched: event.payload.objects_fetched,
          bytesFetched: event.payload.bytes_fetched,
          estimatedTotal: event.payload.estimated_total,
          speed: event.payload.speed,
          isRunning: event.payload.is_running,
        });
      }
    );

    const unlistenComplete = listen<BackgroundSyncCompleteEvent>(
      'background-sync-complete',
      (event) => {
        useSyncStore
          .getState()
          .completeBackgroundSync(event.payload.total_objects, event.payload.total_bytes);
        useSyncStore.getState().setTotalFiles(event.payload.total_objects);

        // Update sync time
        if (config?.accountId && config?.bucket) {
          useSyncStore.getState().setLastSyncTime(config.accountId, config.bucket, Date.now());
        }

        // Clear folder sizes so they reload from the now-accurate directory tree
        clearSizes();

        // Invalidate folder-contents queries so useR2Files refetches with full data
        if (config) {
          queryClient.invalidateQueries({
            queryKey: ['folder-contents', config.provider, config.accountId, config.bucket],
          });
        }
      }
    );

    const unlistenError = listen<string>('background-sync-error', (event) => {
      useSyncStore.getState().failBackgroundSync(event.payload);
      console.error('Background sync error:', event.payload);
    });

    // Also listen for legacy sync events (used by SyncProgress component)
    const unlistenPhase = listen<SyncPhase>('sync-phase', (event) => {
      useSyncStore.getState().setPhase(event.payload);
    });

    const unlistenSyncProgress = listen<number>('sync-progress', (event) => {
      useSyncStore.getState().setProgress(event.payload);
    });

    const unlistenStore = listen<number>('store-progress', (event) => {
      useSyncStore.getState().setStoredFiles(event.payload);
    });

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenPhase.then((fn) => fn());
      unlistenSyncProgress.then((fn) => fn());
      unlistenStore.then((fn) => fn());
    };
  }, [config, queryClient]);

  const isConfigReady = useMemo(() => {
    if (!config?.accountId || !config?.bucket) return false;
    if (config.provider === 'r2') {
      return !!config.accessKeyId && !!config.secretAccessKey;
    }
    if (config.provider === 'aws') {
      return !!config.accessKeyId && !!config.secretAccessKey && !!config.region;
    }
    return (
      !!config.accessKeyId &&
      !!config.secretAccessKey &&
      !!config.endpointHost &&
      !!config.endpointScheme
    );
  }, [config]);

  // Effective sync settings for the current bucket (r2-c6gg): per-bucket
  // overrides win field-by-field over globals. Subscribed reactively so the
  // auto-start effect below re-evaluates when the user changes the mode —
  // e.g. enabling Periodic on the current bucket syncs now instead of
  // waiting for the first interval (r2-knw5 review).
  const autoSyncMode = useSyncSettingsStore((s) => s.autoSyncMode);
  const autoSyncFreshnessSecs = useSyncSettingsStore((s) => s.autoSyncFreshnessSecs);
  const autoSyncPeriodMin = useSyncSettingsStore((s) => s.autoSyncPeriodMin);
  const bucketOverrides = useSyncSettingsStore((s) => s.bucketOverrides);

  // Auto-start background sync when bucket/account/provider changes.
  // Gated by the freshness window (r2-pkmv): a bucket fully synced recently
  // is skipped — the local cache is authoritative after a full sync, so
  // re-listing it immediately gains nothing. Re-runs on settings changes so
  // a mode change (e.g. to Periodic) takes effect immediately; "Sync now"
  // remains available for immediate sync.
  const autoStartConfigRef = useRef<StorageConfig | null>(null);

  useEffect(() => {
    if (!isConfigReady || !config) return;
    autoStartConfigRef.current = config;

    const bucketKey = makeBucketKey(config.provider, config.accountId, config.bucket);
    const isSameBucket = bgStartedRef.current === bucketKey;

    if (isSameBucket) {
      // This re-run was caused by a settings change, not a bucket switch.
      // Never interrupt an in-flight sync — let it finish; the next trigger
      // (switch, mode change, refresh) re-evaluates.
      if (useSyncStore.getState().backgroundSync.isRunning) return;
    } else {
      bgStartedRef.current = bucketKey;
    }

    let cancelled = false;
    const run = async () => {
      // Hydrate the persisted last-sync time (sync_meta) up front so isSynced
      // and the StatusBar/sidebar reflect stored state even when we skip,
      // and so the gate has a timestamp to compare against after restarts.
      //
      // Units: sync_meta.last_sync is Unix *seconds* (chrono timestamp),
      // while bucketSyncTimes stores epoch *milliseconds* (Date.now()) —
      // convert here so the gate and relative-time labels see one unit.
      // When the bucket was never fully synced, clear any stamp left by a
      // folder browse so the gate still re-syncs partial buckets on switch.
      try {
        const summary = await getBucketSummary();
        if (cancelled) return;
        useSyncStore
          .getState()
          .setLastSyncTime(
            config.accountId,
            config.bucket,
            summary.lastSync != null ? summary.lastSync * 1000 : null
          );
      } catch {
        // Non-fatal: the gate falls back to syncing.
      }
      if (cancelled) return;

      const settings = useSyncSettingsStore.getState();
      const lastSync = useSyncStore.getState().getLastSyncTime(config.accountId, config.bucket);
      // Per-bucket overrides (r2-c6gg) win field-by-field over global settings.
      const resolved = resolveBucketSyncSettings(bucketKey, settings.bucketOverrides, settings);
      // A bucket that has *never* been fully synced gets one full sync on its
      // first view even with global auto-sync Off (bootstrap — see
      // shouldStartBackgroundSync). An explicit per-bucket "Never auto-sync"
      // override still wins.
      const shouldSync = shouldStartBackgroundSync({
        mode: resolved.mode,
        lastSyncMs: lastSync,
        freshnessSecs: resolved.freshnessSecs,
        nowMs: Date.now(),
        globalAutoSyncOff: settings.autoSyncMode === 'off',
        explicitlyOptedOut: settings.bucketOverrides[bucketKey]?.autoSyncMode === 'off',
      });

      if (!shouldSync) {
        // Fresh enough or auto-sync off: serve from the local cache. Still
        // invalidate folder queries so the view settles on this bucket's data.
        queryClient.invalidateQueries({
          queryKey: ['folder-contents', config.provider, config.accountId, config.bucket],
        });
        return;
      }

      // Wait for any pending cancel to complete first to avoid the
      // cancel/start race where the new run_id is invalidated immediately.
      try {
        await cancelBackgroundSync();
      } catch {}
      if (cancelled) return;

      useSyncStore.getState().resetProgress();
      useSyncStore.getState().startBackgroundSync();

      try {
        await startBackgroundSync(config);
      } catch (err) {
        console.error('Failed to start background sync:', err);
        useSyncStore
          .getState()
          .failBackgroundSync(err instanceof Error ? err.message : String(err));
      }

      // Force-refetch the current folder for the new bucket so the file list
      // doesn't reuse the previous account's results during the transition.
      queryClient.invalidateQueries({
        queryKey: ['folder-contents', config.provider, config.accountId, config.bucket],
      });
    };
    run();

    return () => {
      cancelled = true;
      // Cancel the backend only when leaving this bucket — a settings-only
      // re-run must not cancel an in-flight sync (review). bgStartedRef stays
      // set on a settings re-run so the effect recognizes it as the same
      // bucket next time.
      const latest = autoStartConfigRef.current;
      const leftBucket =
        latest == null ||
        latest.provider !== config.provider ||
        latest.accountId !== config.accountId ||
        latest.bucket !== config.bucket;
      if (leftBucket) {
        cancelBackgroundSync().catch(() => {});
        bgStartedRef.current = null;
      }
    };
  }, [
    isConfigReady,
    config?.provider,
    config?.accountId,
    config?.bucket,
    autoSyncMode,
    autoSyncFreshnessSecs,
    autoSyncPeriodMin,
    bucketOverrides,
    queryClient,
  ]);

  // Periodic auto-sync (r2-knw5 + r2-c6gg): while the resolved mode for the
  // current bucket is 'periodic', re-run the full background sync every
  // periodMin. The interval resets on config/settings changes; a tick is
  // skipped while any sync is already in flight so runs never overlap.
  useEffect(() => {
    if (!isConfigReady || !config) return;

    const bucketKey = makeBucketKey(config.provider, config.accountId, config.bucket);
    const resolved = resolveBucketSyncSettings(bucketKey, bucketOverrides, {
      autoSyncMode,
      autoSyncFreshnessSecs: 0, // the interval re-runs unconditionally
      autoSyncPeriodMin,
    });
    if (resolved.mode !== 'periodic') return;

    const periodMs = resolved.periodMin * 60_000;
    const id = window.setInterval(async () => {
      if (useSyncStore.getState().backgroundSync.isRunning) return;
      // A tick queued before the interval was torn down can fire after a
      // bucket switch. syncBucketNow cancels the running sync first, so a
      // stale tick would cancel the new bucket's sync and re-list the old
      // bucket (stamping the wrong last-sync/counts). Skip unless this tick's
      // bucket is still the current selection (r2-knw5 review).
      if (useSyncStore.getState().currentBucketKey !== `${config.accountId}:${config.bucket}`) {
        return;
      }
      try {
        await syncBucketNow(config);
      } catch (err) {
        console.error('Periodic sync failed:', err);
        useSyncStore
          .getState()
          .failBackgroundSync(err instanceof Error ? err.message : String(err));
      }
    }, periodMs);
    return () => window.clearInterval(id);
  }, [
    isConfigReady,
    config?.provider,
    config?.accountId,
    config?.bucket,
    autoSyncMode,
    autoSyncPeriodMin,
    bucketOverrides,
  ]);

  // Background sync state for return values
  const backgroundSync = useSyncStore((state) => state.backgroundSync);

  /**
   * Force a full-bucket background sync now, bypassing the freshness gate.
   * Shared with the sidebar "Sync now" action (r2-twoe).
   */
  const refresh = useCallback(async () => {
    if (!config) return;

    clearSizes();
    bgStartedRef.current = null;

    try {
      await syncBucketNow(config);
    } catch (err) {
      console.error('Failed to restart background sync:', err);
      useSyncStore.getState().failBackgroundSync(err instanceof Error ? err.message : String(err));
    }

    // Also invalidate folder-contents so useR2Files refetches current folder
    await queryClient.invalidateQueries({
      queryKey: ['folder-contents', config.provider, config.accountId, config.bucket],
    });
  }, [queryClient, config, clearSizes]);

  return {
    // isSyncing: true while background sync is running
    isSyncing: backgroundSync.isRunning,
    // isSynced: true once we have at least some data (lazy sync sets lastSyncTime)
    isSynced: lastSyncTime !== null,
    syncError: backgroundSync.error ? new Error(backgroundSync.error) : null,
    lastSyncTime,
    refresh,
  };
}
