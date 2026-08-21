import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface CacheUpdatedEvent {
  action: 'delete' | 'move' | 'update';
  affected_paths: string[];
}

interface PathsRemovedEvent {
  removed_paths: string[];
}

interface PathsCreatedEvent {
  created_paths: string[];
}

interface CurrentPathStore {
  currentPath: string;
  /** Bucket currently being browsed — paths are recorded under this key. */
  bucketKey: string | null;
  /** Persisted: last folder path per bucket ("<provider>:<account>:<bucket>"). */
  pathsByBucket: Record<string, string>;
  cacheUpdatedPaths: string[];
  removedPaths: string[];
  createdPaths: string[];
  setBucketKey: (key: string | null) => void;
  setCurrentPath: (path: string) => void;
  /** Restore the last path for a bucket (app startup) and select that bucket. */
  restorePath: (key: string) => void;
  goToParent: () => void;
  reset: () => void;
}

function getParentPath(path: string): string {
  if (!path) return '';
  const withoutTrailing = path.endsWith('/') ? path.slice(0, -1) : path;
  const lastSlash = withoutTrailing.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return `${withoutTrailing.slice(0, lastSlash + 1)}`;
}

export const useCurrentPathStore = create<CurrentPathStore>()(
  persist(
    (set, get) => ({
      currentPath: '',
      bucketKey: null,
      pathsByBucket: {},
      cacheUpdatedPaths: [],
      removedPaths: [],
      createdPaths: [],
      setBucketKey: (key) => set({ bucketKey: key }),
      setCurrentPath: (path) =>
        set((state) => ({
          currentPath: path,
          ...(state.bucketKey
            ? { pathsByBucket: { ...state.pathsByBucket, [state.bucketKey]: path } }
            : {}),
        })),
      restorePath: (key) =>
        set((state) => ({ bucketKey: key, currentPath: state.pathsByBucket[key] ?? '' })),
      goToParent: () => {
        const { currentPath } = get();
        get().setCurrentPath(getParentPath(currentPath));
      },
      reset: () => set({ currentPath: '' }),
    }),
    {
      name: 'current-path-storage',
      version: 2,
      // Persist only the per-bucket paths; the live path and event batches
      // are session state.
      partialize: (state) => ({ pathsByBucket: state.pathsByBucket }),
      migrate: (persistedState, version) => {
        const incoming = (persistedState ?? {}) as Partial<CurrentPathStore>;
        if (version < 2) {
          // v1 stored a single global currentPath with no bucket context —
          // not safely restorable (it could apply to the wrong bucket), so
          // drop it and start the per-bucket map empty.
          return { pathsByBucket: {} } as CurrentPathStore;
        }
        return incoming as CurrentPathStore;
      },
      storage: createJSONStorage(() => localStorage),
    }
  )
);

let unlistenCacheUpdated: UnlistenFn | undefined;
let unlistenPathsRemoved: UnlistenFn | undefined;
let unlistenPathsCreated: UnlistenFn | undefined;

async function ensureEventListeners() {
  if (unlistenCacheUpdated && unlistenPathsRemoved && unlistenPathsCreated) return;

  if (!unlistenCacheUpdated) {
    unlistenCacheUpdated = await listen<CacheUpdatedEvent>('cache-updated', (event) => {
      const { affected_paths } = event.payload;
      useCurrentPathStore.setState({ cacheUpdatedPaths: [...affected_paths] });
    });
  }

  if (!unlistenPathsRemoved) {
    unlistenPathsRemoved = await listen<PathsRemovedEvent>('paths-removed', (event) => {
      const { removed_paths } = event.payload;
      useCurrentPathStore.setState({ removedPaths: [...removed_paths] });

      const { currentPath, setCurrentPath } = useCurrentPathStore.getState();
      if (removed_paths.includes(currentPath)) {
        const removedSet = new Set(removed_paths);
        let nextPath = currentPath;
        while (nextPath && removedSet.has(nextPath)) {
          nextPath = getParentPath(nextPath);
        }
        setCurrentPath(nextPath);
      }
    });
  }

  if (!unlistenPathsCreated) {
    unlistenPathsCreated = await listen<PathsCreatedEvent>('paths-created', (event) => {
      const { created_paths } = event.payload;
      useCurrentPathStore.setState({ createdPaths: [...created_paths] });
    });
  }
}

if (typeof window !== 'undefined') {
  void ensureEventListeners();
}
