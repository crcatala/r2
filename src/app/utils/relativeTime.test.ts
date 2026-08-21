import { describe, expect, test } from 'bun:test';
import {
  STALE_THRESHOLD_MS,
  bucketSyncLabel,
  formatRelativeTime,
  isStaleSync,
} from './relativeTime';

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  test('empty for null', () => {
    expect(formatRelativeTime(null)).toBe('');
  });

  test('granularity down to minutes', () => {
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe('1 min ago');
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe('5 min ago');
  });

  test('hours and days', () => {
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe('1 hr ago');
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe('3 hr ago');
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe('1 day ago');
    expect(formatRelativeTime(NOW - 4 * DAY, NOW)).toBe('4 days ago');
  });
});

describe('isStaleSync', () => {
  test('auto-sync on never marks stale', () => {
    expect(isStaleSync({ autoSyncMode: 'on-switch', lastSyncMs: null, nowMs: NOW })).toBe(false);
    expect(isStaleSync({ autoSyncMode: 'on-switch', lastSyncMs: NOW - 30 * DAY, nowMs: NOW })).toBe(
      false
    );
  });

  test('never-synced bucket is stale when auto-sync is off', () => {
    expect(isStaleSync({ autoSyncMode: 'off', lastSyncMs: null, nowMs: NOW })).toBe(true);
  });

  test('stale only after the threshold in off mode', () => {
    expect(isStaleSync({ autoSyncMode: 'off', lastSyncMs: NOW - 12 * HOUR, nowMs: NOW })).toBe(
      false
    );
    expect(
      isStaleSync({ autoSyncMode: 'off', lastSyncMs: NOW - STALE_THRESHOLD_MS - 1, nowMs: NOW })
    ).toBe(true);
  });
});

describe('bucketSyncLabel', () => {
  test('nothing to show for never-synced bucket with auto-sync on', () => {
    expect(bucketSyncLabel({ lastSyncMs: null, stale: false })).toBe('');
  });

  test('not synced only when stale', () => {
    expect(bucketSyncLabel({ lastSyncMs: null, stale: true })).toBe('Not synced');
  });

  test('stale label prefixes with Stale ·', () => {
    expect(bucketSyncLabel({ lastSyncMs: NOW - 2 * DAY, stale: true, nowMs: NOW })).toBe(
      'Stale · 2 days ago'
    );
  });

  test('fresh label is plain relative time', () => {
    expect(bucketSyncLabel({ lastSyncMs: NOW - 2 * MIN, stale: false, nowMs: NOW })).toBe(
      '2 min ago'
    );
  });
});
