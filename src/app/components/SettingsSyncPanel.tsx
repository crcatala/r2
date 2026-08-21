'use client';

import {
  useSyncSettingsStore,
  FRESHNESS_WINDOW_OPTIONS,
  type AutoSyncMode,
} from '@/app/stores/settingsStore';

const AUTO_SYNC_MODES: Array<{ id: AutoSyncMode; label: string; sub: string }> = [
  {
    id: 'on-switch',
    label: 'On switch',
    sub: 'Sync a bucket when you open it, unless synced recently',
  },
  {
    id: 'off',
    label: 'Off',
    sub: 'Only sync when you ask — local edits still update the cache',
  },
];

export default function SettingsSyncPanel() {
  const autoSyncMode = useSyncSettingsStore((s) => s.autoSyncMode);
  const setAutoSyncMode = useSyncSettingsStore((s) => s.setAutoSyncMode);
  const autoSyncFreshnessSecs = useSyncSettingsStore((s) => s.autoSyncFreshnessSecs);
  const setAutoSyncFreshnessSecs = useSyncSettingsStore((s) => s.setAutoSyncFreshnessSecs);

  const freshnessDisabled = autoSyncMode === 'off';

  return (
    <div className="settings-section-stack">
      {/* Auto-sync mode */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Automatic sync</h3>
            <p>When to refresh a bucket's file catalog from the server.</p>
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

      {/* Manual sync */}
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Manual sync</h3>
            <p>
              Sync now lives in the bucket menu in the sidebar (full bucket). The toolbar refresh
              re-lists just the folder you're viewing.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
