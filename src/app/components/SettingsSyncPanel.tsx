'use client';

import { useMemo, useRef, useEffect } from 'react';
import { Select } from 'antd';
import {
  useSyncSettingsStore,
  FRESHNESS_WINDOW_OPTIONS,
  FOLDER_TTL_OPTIONS,
  PERIOD_OPTIONS,
  makeBucketKey,
  type AutoSyncMode,
  type BucketSyncOverride,
  type BucketKey,
} from '@/app/stores/settingsStore';
import { useAccountStore, type ProviderAccount } from '@/app/stores/accountStore';

const AUTO_SYNC_MODES: Array<{ id: AutoSyncMode; label: string; sub: string }> = [
  {
    id: 'on-switch',
    label: 'On switch',
    sub: 'Sync a bucket when you open it, unless synced recently',
  },
  {
    id: 'periodic',
    label: 'Periodic',
    sub: 'Keep the current bucket in sync on a fixed interval while selected',
  },
  {
    id: 'off',
    label: 'Off',
    sub: 'Only sync when you ask — local edits still update the cache',
  },
];

// Per-bucket override select values: 'global' = fall back to global settings.
const OVERRIDE_MODE_OPTIONS = [
  { value: 'global', label: 'Follow global' },
  { value: 'on-switch', label: 'On switch' },
  { value: 'periodic', label: 'Periodic' },
  { value: 'off', label: 'Never auto-sync' },
];

type OverrideModeValue = 'global' | AutoSyncMode;

const OVERRIDE_FRESHNESS_OPTIONS = [
  { value: 'global', label: 'Follow global' },
  ...FRESHNESS_WINDOW_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
];

const OVERRIDE_PERIOD_OPTIONS = [
  { value: 'global', label: 'Follow global' },
  ...PERIOD_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
];

const PROVIDER_LABEL: Record<ProviderAccount['provider'], string> = {
  r2: 'R2',
  aws: 'S3',
  minio: 'MinIO',
  rustfs: 'RustFS',
};

function BucketOverrideRow({
  bucketKey,
  bucket,
  accountLabel,
  provider,
  highlighted,
}: {
  bucketKey: BucketKey;
  bucket: string;
  accountLabel: string;
  provider: ProviderAccount['provider'];
  highlighted: boolean;
}) {
  const bucketOverrides = useSyncSettingsStore((s) => s.bucketOverrides);
  const setBucketOverride = useSyncSettingsStore((s) => s.setBucketOverride);
  const removeBucketOverride = useSyncSettingsStore((s) => s.removeBucketOverride);

  const override = bucketOverrides[bucketKey];
  const mode: OverrideModeValue = override?.autoSyncMode ?? 'global';
  const freshness: string | 'global' =
    override?.freshnessSecs != null ? String(override.freshnessSecs) : 'global';
  const period: string | 'global' =
    override?.periodicMin != null ? String(override.periodicMin) : 'global';

  /** Write a partial override; drop the row entirely when nothing remains. */
  function update(patch: BucketSyncOverride) {
    const merged = { ...override, ...patch };
    const next: BucketSyncOverride = {};
    for (const [k, v] of Object.entries(merged) as Array<[keyof BucketSyncOverride, unknown]>) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    if (Object.keys(next).length === 0) {
      removeBucketOverride(bucketKey);
    } else {
      setBucketOverride(bucketKey, next);
    }
  }

  return (
    <div className={['sync-override-row', highlighted ? 'active' : ''].filter(Boolean).join(' ')}>
      <div className="sync-override-meta">
        <strong>{bucket}</strong>
        <span>
          {PROVIDER_LABEL[provider]} · {accountLabel}
        </span>
      </div>
      <div className="sync-override-controls">
        {mode === 'periodic' && (
          <Select
            size="small"
            value={period}
            options={OVERRIDE_PERIOD_OPTIONS}
            onChange={(v) => update({ periodicMin: v === 'global' ? undefined : Number(v) })}
            popupMatchSelectWidth={false}
            style={{ width: 130 }}
          />
        )}
        {mode === 'on-switch' && (
          <Select
            size="small"
            value={freshness}
            options={OVERRIDE_FRESHNESS_OPTIONS}
            onChange={(v) => update({ freshnessSecs: v === 'global' ? undefined : Number(v) })}
            popupMatchSelectWidth={false}
            style={{ width: 130 }}
          />
        )}
        <Select
          size="small"
          value={mode}
          options={OVERRIDE_MODE_OPTIONS}
          onChange={(v: OverrideModeValue) =>
            update({ autoSyncMode: v === 'global' ? undefined : v })
          }
          popupMatchSelectWidth={false}
          style={{ width: 150 }}
        />
      </div>
    </div>
  );
}

export default function SettingsSyncPanel({ highlightBucketKey }: { highlightBucketKey?: string }) {
  const autoSyncMode = useSyncSettingsStore((s) => s.autoSyncMode);
  const setAutoSyncMode = useSyncSettingsStore((s) => s.setAutoSyncMode);
  const autoSyncFreshnessSecs = useSyncSettingsStore((s) => s.autoSyncFreshnessSecs);
  const setAutoSyncFreshnessSecs = useSyncSettingsStore((s) => s.setAutoSyncFreshnessSecs);
  const autoSyncPeriodMin = useSyncSettingsStore((s) => s.autoSyncPeriodMin);
  const setAutoSyncPeriodMin = useSyncSettingsStore((s) => s.setAutoSyncPeriodMin);
  const folderCacheTtlSecs = useSyncSettingsStore((s) => s.folderCacheTtlSecs);
  const setFolderCacheTtlSecs = useSyncSettingsStore((s) => s.setFolderCacheTtlSecs);

  const accounts = useAccountStore((s) => s.accounts);

  const bucketRows = useMemo(() => {
    const rows: Array<{
      key: BucketKey;
      bucket: string;
      accountLabel: string;
      provider: ProviderAccount['provider'];
    }> = [];
    for (const a of accounts) {
      const accountLabel = a.account.name ?? a.account.id;
      if (a.provider === 'r2') {
        for (const td of a.tokens) {
          for (const b of td.buckets) {
            rows.push({
              key: makeBucketKey('r2', a.account.id, b.name),
              bucket: b.name,
              accountLabel,
              provider: 'r2',
            });
          }
        }
      } else {
        for (const b of a.buckets) {
          rows.push({
            key: makeBucketKey(a.provider, a.account.id, b.name),
            bucket: b.name,
            accountLabel,
            provider: a.provider,
          });
        }
      }
    }
    return rows;
  }, [accounts]);

  const bucketOverrides = useSyncSettingsStore((s) => s.bucketOverrides);
  // Only count overrides for buckets that still exist — a deleted bucket's
  // stale override must not inflate the pill (r2-c6gg review).
  const overrideCount = bucketRows.filter((r) => bucketOverrides[r.key]).length;

  // Scroll a highlighted override row into view (opened via sidebar "Sync
  // settings…"). The ref sits on the scrollable list; the active row is the
  // one carrying the .active class (r2-c6gg review).
  const highlightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightBucketKey && highlightRef.current) {
      highlightRef.current
        .querySelector('.sync-override-row.active')
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightBucketKey]);

  const freshnessDisabled = autoSyncMode === 'off';
  const periodDisabled = autoSyncMode !== 'periodic';

  return (
    <div className="settings-section-stack">
      {/* Auto-sync mode */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Automatic sync</h3>
            <p>When to refresh a bucket&apos;s file catalog from the server.</p>
          </div>
        </div>
        <div className="option-row-list">
          {AUTO_SYNC_MODES.map((m) => (
            <button
              key={m.id}
              className={['option-row', autoSyncMode === m.id && 'active']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setAutoSyncMode(m.id)}
            >
              <span className="option-row-text">
                <strong>{m.label}</strong>
                <span>{m.sub}</span>
              </span>
              <span className="option-row-radio" />
            </button>
          ))}
        </div>
      </section>

      {/* Freshness window */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Freshness window</h3>
            <p>
              Skip the automatic sync when the bucket was fully synced this recently — a fresh sync
              is authoritative, so re-listing immediately gains nothing.
            </p>
          </div>
        </div>
        <div className="option-row-list">
          {FRESHNESS_WINDOW_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={['option-row', autoSyncFreshnessSecs === o.value && 'active']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setAutoSyncFreshnessSecs(o.value)}
              style={freshnessDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              disabled={freshnessDisabled}
            >
              <span className="option-row-text">
                <strong>{o.label}</strong>
                <span>Skips the re-list if the bucket synced within this window</span>
              </span>
              <span className="option-row-radio" />
            </button>
          ))}
        </div>
      </section>

      {/* Periodic interval */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Sync interval</h3>
            <p>
              How often to re-run the full background sync while a bucket is selected in periodic
              mode.
            </p>
          </div>
        </div>
        <div className="option-row-list">
          {PERIOD_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={['option-row', autoSyncPeriodMin === o.value && 'active']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setAutoSyncPeriodMin(o.value)}
              style={periodDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              disabled={periodDisabled}
            >
              <span className="option-row-text">
                <strong>{o.label}</strong>
                <span>Full bucket catalog refresh while selected</span>
              </span>
              <span className="option-row-radio" />
            </button>
          ))}
        </div>
      </section>

      {/* Folder cache TTL */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Folder cache</h3>
            <p>
              How long a folder&apos;s listing stays cached before re-listing from the network. Only
              applies before a bucket&apos;s first full sync — after a full sync the cache is
              authoritative regardless of the automatic sync mode. &quot;Always refresh&quot; hits
              the network on every folder open.
            </p>
          </div>
        </div>
        <div className="option-row-list">
          {FOLDER_TTL_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={['option-row', folderCacheTtlSecs === o.value && 'active']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setFolderCacheTtlSecs(o.value)}
            >
              <span className="option-row-text">
                <strong>{o.label}</strong>
                <span>
                  {o.value === 0
                    ? 'Never serve a folder from partial-cache browsing'
                    : 'Fresh listings are served from cache for this long'}
                </span>
              </span>
              <span className="option-row-radio" />
            </button>
          ))}
        </div>
      </section>

      {/* Per-bucket overrides */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Per-bucket overrides</h3>
            <p>
              Opt specific buckets out of auto-sync or give them their own mode — e.g. a giant
              archive bucket that should never re-list on its own. Unset fields follow the global
              settings above.
            </p>
          </div>
          {overrideCount > 0 && (
            <span className="settings-pill mono">
              {overrideCount} override{overrideCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {bucketRows.length === 0 ? (
          <div className="settings-section-note">
            No buckets yet — add a connection to tune it here.
          </div>
        ) : (
          <div className="sync-override-list" ref={highlightRef}>
            {bucketRows.map((row) => (
              <BucketOverrideRow
                key={row.key}
                bucketKey={row.key}
                bucket={row.bucket}
                accountLabel={row.accountLabel}
                provider={row.provider}
                highlighted={highlightBucketKey === row.key}
              />
            ))}
          </div>
        )}
      </section>

      {/* Manual sync */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Manual sync</h3>
            <p>
              Sync now lives in the bucket menu in the sidebar (full bucket). The toolbar refresh
              re-lists just the folder you&apos;re viewing.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
