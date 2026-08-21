import type { AutoSyncMode } from '@/app/stores/settingsStore';

/**
 * Shared relative-time helpers for sync status display (StatusBar pill,
 * sidebar bucket rows). Extracted from StatusBar.tsx so the sidebar can
 * reuse it without duplicating the formatting.
 */

/** Show a "Stale" hint when auto-sync is off and a bucket hasn't synced in this long. */
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function formatRelativeTime(timestamp: number | null, nowMs: number = Date.now()): string {
  if (!timestamp) return '';
  const diffMs = nowMs - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin === 1) return '1 min ago';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr === 1) return '1 hr ago';
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return '1 day ago';
  return `${diffDays} days ago`;
}

/**
 * Whether a bucket's cached listing should be flagged as potentially stale.
 * Only applies when auto-sync is off: local edits are tracked incrementally,
 * but remote changes won't appear until a manual sync. A bucket that was
 * never synced is stale by definition in this mode.
 */
export function isStaleSync(params: {
  autoSyncMode: AutoSyncMode;
  lastSyncMs: number | null;
  nowMs: number;
}): boolean {
  const { autoSyncMode, lastSyncMs, nowMs } = params;
  if (autoSyncMode !== 'off') return false;
  if (lastSyncMs == null) return true;
  return nowMs - lastSyncMs > STALE_THRESHOLD_MS;
}

/**
 * Short label for a sidebar bucket row. Empty when there is nothing to say
 * (auto-sync on, never synced yet — it will sync on switch). "Not synced"
 * only appears in auto-sync-off mode.
 */
export function bucketSyncLabel(params: {
  lastSyncMs: number | null;
  stale: boolean;
  nowMs?: number;
}): string {
  const { lastSyncMs, stale, nowMs } = params;
  if (lastSyncMs == null) return stale ? 'Not synced' : '';
  return stale
    ? `Stale · ${formatRelativeTime(lastSyncMs, nowMs)}`
    : formatRelativeTime(lastSyncMs, nowMs);
}
