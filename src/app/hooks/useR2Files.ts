import { useCallback, useEffect, useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getAllFiles, getFolderContents, listPrefix } from '@/app/lib/r2cache';
import { StorageConfig } from '@/app/lib/r2cache';
import { useSyncStore } from '@/app/stores/syncStore';
import { useSyncSettingsStore } from '@/app/stores/settingsStore';
import { useCurrentPathStore } from '@/app/stores/currentPathStore';
import { loadFolderItems } from '@/app/utils/folderItems';
import type { FileItem } from '@/app/utils/folderItems';

export type { FileItem } from '@/app/utils/folderItems';

// Event emitted by backend when cache is updated
interface MoveStatusChangedEvent {
  task_id: string;
  status: string;
  error: string | null;
}

function getParentPath(path: string): string {
  if (!path) return '';
  const withoutTrailing = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = withoutTrailing.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return `${withoutTrailing.slice(0, lastSlash + 1)}`;
}

export function useR2Files(config: StorageConfig | null, prefix: string = '') {
  const queryClient = useQueryClient();
  const queryKey = ['folder-contents', config?.provider, config?.accountId, config?.bucket, prefix];

  // Get per-bucket sync time - only load from cache after sync completes
  const bucketSyncTimes = useSyncStore((state) => state.bucketSyncTimes);
  const folderCacheTtlSecs = useSyncSettingsStore((s) => s.folderCacheTtlSecs);
  const lastSyncTime = useMemo(() => {
    if (!config?.accountId || !config?.bucket) return null;
    return useSyncStore.getState().getLastSyncTime(config.accountId, config.bucket);
  }, [config?.accountId, config?.bucket, bucketSyncTimes]);

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

  /**
   * Shared folder loader. forceRefresh=true bypasses the cache-first shortcut
   * (TTL / authoritative-cache after full sync) and hits the network LIST.
   */
  const loadFolder = useCallback(
    async (forceRefresh: boolean): Promise<FileItem[]> => {
      if (!config) return [];
      try {
        const result = await loadFolderItems({
          config,
          prefix,
          forceRefresh,
          // Folder browse TTL (r2-ywug): sent to list_prefix so the backend
          // serves a partial-cache prefix within this window from SQLite.
          // Only matters before the bucket's first full sync.
          cacheTtlSecs: useSyncSettingsStore.getState().folderCacheTtlSecs,
          readCachedFolder: getFolderContents,
          readAllCachedFiles: getAllFiles,
          readPrefixFolder: listPrefix,
        });

        // Only a genuine network LIST (source 'prefix') marks the bucket as
        // freshly browsed — a cache-served listing (from_cache) means nothing
        // synced, so it must not stamp "Synced just now" on the sidebar or
        // fool the freshness gate.
        if (result.source === 'prefix') {
          useSyncStore.getState().setLastSyncTime(config.accountId, config.bucket, Date.now());
        }

        return result.items;
      } catch (err) {
        // No cache fallback was available — propagate so callers can tell a
        // real failure apart from an empty folder. forceRefreshFolder must
        // not overwrite the list with [] on failure (r2-twoe review).
        console.warn('[useR2Files] failed to load prefix and no cache fallback was available:', {
          prefix,
          err,
        });
        throw err;
      }
    },
    [config, prefix]
  );

  const query = useQuery({
    queryKey,
    // Preserve the pre-existing swallow for initial loads: a failed first
    // load renders an empty list rather than surfacing an error state.
    queryFn: async () => {
      try {
        return await loadFolder(false);
      } catch {
        return [];
      }
    },
    // Enable immediately when config is ready — lazy sync handles missing cache
    enabled: isConfigReady,
    retry: 1,
    // Cache-updated events invalidate affected folders explicitly, so a
    // short staleTime only suppresses redundant remount/refocus refetches.
    // With the folder TTL set to "Always refresh" (0), every folder revisit
    // must re-list from the network — go stale immediately so react-query
    // cannot mask the setting (r2-ywug review).
    staleTime: folderCacheTtlSecs === 0 ? 0 : 30_000,
    // Keep the previous folder on screen while the next one resolves —
    // navigation swaps lists instead of blanking.
    placeholderData: keepPreviousData,
  });

  // Sync isFetching state to zustand store as isFolderLoading
  useEffect(() => {
    useSyncStore.getState().setIsFolderLoading(query.isFetching);
  }, [query.isFetching]);

  const cacheUpdatedPaths = useCurrentPathStore((state) => state.cacheUpdatedPaths);
  const removedPaths = useCurrentPathStore((state) => state.removedPaths);
  const createdPaths = useCurrentPathStore((state) => state.createdPaths);

  // Auto-refresh affected folders when cache changes
  useEffect(() => {
    if (!config?.bucket) return;

    const invalidateFolderQueries = (paths: string[]) => {
      for (const path of paths) {
        queryClient.invalidateQueries({
          queryKey: ['folder-contents', config.provider, config.accountId, config.bucket, path],
        });
      }
    };

    const invalidateParentQueries = (paths: string[]) => {
      const parentPaths = new Set(paths.map(getParentPath));
      invalidateFolderQueries(Array.from(parentPaths));
    };
    if (cacheUpdatedPaths.length > 0) {
      invalidateFolderQueries(cacheUpdatedPaths);
    }
    if (removedPaths.length > 0) {
      invalidateParentQueries(removedPaths);
    }
    if (createdPaths.length > 0) {
      invalidateParentQueries(createdPaths);
    }
  }, [
    config?.bucket,
    config?.accountId,
    config?.provider,
    queryClient,
    cacheUpdatedPaths,
    removedPaths,
    createdPaths,
  ]);

  // Refresh current folder list after move completes
  useEffect(() => {
    if (!config?.bucket || !config?.accountId) return;

    let unlisten: UnlistenFn | undefined;

    const setup = async () => {
      unlisten = await listen<MoveStatusChangedEvent>('move-status-changed', (event) => {
        if (event.payload.status === 'success') {
          queryClient.invalidateQueries({
            queryKey: ['folder-contents', config.provider, config.accountId, config.bucket, prefix],
          });
        }
      });
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, [config?.bucket, config?.accountId, config?.provider, prefix, queryClient]);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey });
  }

  /**
   * Re-list the current folder from the remote (bypasses the cache
   * freshness shortcut) and write the result into the query cache.
   * Throws when there is no cache fallback and the LIST fails, so callers
   * (page.tsx handleRefresh) can toast a failure — the list is never
   * overwritten with [] on error.
   */
  async function forceRefreshFolder() {
    if (!config) return;
    const items = await loadFolder(true);
    queryClient.setQueryData<FileItem[]>(queryKey, items);
  }

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refresh,
    forceRefreshFolder,
  };
}
