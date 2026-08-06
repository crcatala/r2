import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

// Global listener state - persists across component unmounts
let globalListenersSetup = false;
let globalUnlisteners: UnlistenFn[] = [];

export type MountProvider = 'r2' | 'aws' | 'minio' | 'rustfs';

/** A live mount, as reported by the backend (camelCase mirror of `MountInfoPayload`). */
export interface MountInfo {
  mountId: string;
  provider: MountProvider;
  accountId: string;
  bucket: string;
  localPath: string;
  port: number;
  readOnly: boolean;
  mountedAt: number;
}

/** Raw `MountInfo` shape on the wire — snake_case, as the Rust structs serialize. */
export interface MountInfoPayload {
  mount_id: string;
  provider: MountProvider;
  account_id: string;
  bucket: string;
  local_path: string;
  port: number;
  read_only: boolean;
  mounted_at: number;
}

/** `mount-changed` payload: the backend always sends the full mount list. */
export interface MountChangedEvent {
  mounts: MountInfoPayload[];
}

/** Argument to `mount_bucket`. Field names must stay snake_case for serde. */
export interface MountBucketInput {
  provider: MountProvider;
  account_id: string;
  bucket: string;
  local_path: string;
  access_key_id: string;
  secret_access_key: string;
  region?: string | null;
  endpoint_url?: string | null;
  force_path_style?: boolean | null;
}

/**
 * Everything needed to mount one bucket, captured when the menu item is
 * clicked. Credentials come straight off the sidebar's account/token data, so
 * any listed bucket can be mounted without first selecting it.
 */
export interface MountTarget {
  provider: MountProvider;
  accountId: string;
  accountLabel: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string | null;
  endpointUrl?: string | null;
  forcePathStyle?: boolean | null;
}

interface MountStore {
  mounts: MountInfo[];
  modalOpen: boolean;
  target: MountTarget | null;
  isMounting: boolean;
  isUnmounting: boolean;
  error: string | null;

  openMountModal: (target: MountTarget) => void;
  closeMountModal: () => void;
  clearError: () => void;
  setMounts: (mounts: MountInfo[]) => void;
  refreshMounts: () => Promise<void>;
  mount: (input: MountBucketInput) => Promise<MountInfo | null>;
  unmount: (mountId: string) => Promise<boolean>;
}

export function toMountInfo(payload: MountInfoPayload): MountInfo {
  return {
    mountId: payload.mount_id,
    provider: payload.provider,
    accountId: payload.account_id,
    bucket: payload.bucket,
    localPath: payload.local_path,
    port: payload.port,
    readOnly: payload.read_only,
    mountedAt: payload.mounted_at,
  };
}

function errorMessage(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export const useMountStore = create<MountStore>((set, get) => ({
  mounts: [],
  modalOpen: false,
  target: null,
  isMounting: false,
  isUnmounting: false,
  error: null,

  openMountModal: (target) => set({ modalOpen: true, target, error: null }),

  closeMountModal: () => set({ modalOpen: false, error: null }),

  clearError: () => set({ error: null }),

  setMounts: (mounts) => set({ mounts }),

  refreshMounts: async () => {
    try {
      const mounts = await invoke<MountInfoPayload[]>('list_mounts');
      set({ mounts: mounts.map(toMountInfo) });
    } catch (e) {
      console.error('Failed to list mounts:', e);
    }
  },

  mount: async (input) => {
    set({ isMounting: true, error: null });
    try {
      const payload = await invoke<MountInfoPayload>('mount_bucket', { input });
      const info = toMountInfo(payload);
      // Merge eagerly: `mount-changed` also lands, but the modal switches to
      // its mounted state on this return value alone.
      set((state) => ({
        mounts: [...state.mounts.filter((m) => m.mountId !== info.mountId), info],
        isMounting: false,
      }));
      return info;
    } catch (e) {
      set({ isMounting: false, error: errorMessage(e) });
      return null;
    }
  },

  unmount: async (mountId) => {
    set({ isUnmounting: true, error: null });
    try {
      await invoke('unmount_bucket', { mountId });
      set((state) => ({
        mounts: state.mounts.filter((m) => m.mountId !== mountId),
        isUnmounting: false,
      }));
      return true;
    } catch (e) {
      set({ isUnmounting: false, error: errorMessage(e) });
      return false;
    }
  },
}));

// ── Selectors ─────────────────────────────────────────────────────

/** The live mount for one bucket, or undefined. Buckets are keyed per account. */
export function findMount(
  mounts: MountInfo[],
  provider: MountProvider,
  accountId: string,
  bucket: string
): MountInfo | undefined {
  return mounts.find(
    (m) => m.provider === provider && m.accountId === accountId && m.bucket === bucket
  );
}

export function isBucketMounted(
  mounts: MountInfo[],
  provider: MountProvider,
  accountId: string,
  bucket: string
): boolean {
  return findMount(mounts, provider, accountId, bucket) !== undefined;
}

/** Ask the backend where this bucket would mount by default (e.g. `~/CloudMounts/photos`). */
export async function defaultMountPath(bucket: string): Promise<string> {
  return invoke<string>('default_mount_path', { bucket });
}

/**
 * Setup the global mount listener and load the current mount list. Called once
 * on app initialization; survives component unmounts so the sidebar's mounted
 * indicators stay accurate whether or not the mount modal is open.
 */
export async function setupGlobalMountListeners(): Promise<void> {
  if (globalListenersSetup) return;
  globalListenersSetup = true;

  try {
    const unlistenChanged = await listen<MountChangedEvent>('mount-changed', (event) => {
      useMountStore.getState().setMounts(event.payload.mounts.map(toMountInfo));
    });
    globalUnlisteners.push(unlistenChanged);
    await useMountStore.getState().refreshMounts();
  } catch (e) {
    console.error('Failed to setup global mount listeners:', e);
    globalListenersSetup = false;
  }
}
