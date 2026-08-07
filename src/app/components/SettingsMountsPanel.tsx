'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App } from 'antd';
import { DisconnectOutlined, FolderOpenOutlined, LinkOutlined } from '@ant-design/icons';
import { ProviderIcon } from '@/app/components/AccountSidebarRows';
import { useMountStore, type MountInfo } from '@/app/stores/mountStore';
import {
  detectOs,
  middleTruncate,
  mountModeLabel,
  relativeMountTime,
  revealActionLabel,
} from '@/app/utils/mount';

/** Relative times go stale while the panel sits open; re-read the clock. */
const CLOCK_TICK_MS = 30_000;

function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* ── One live mount ──────────────────────────────────────────────── */
function MountRow({
  mount,
  now,
  busy,
  revealLabel,
  onReveal,
  onUnmount,
}: {
  mount: MountInfo;
  now: number;
  busy: boolean;
  revealLabel: string;
  onReveal: (mount: MountInfo) => void;
  onUnmount: (mount: MountInfo) => void;
}) {
  return (
    <div className="settings-mount-card">
      <ProviderIcon provider={mount.provider} />

      <div className="settings-mount-card-body">
        {/* The mount schematic at list scale: bucket ─●─ folder */}
        <div className="settings-mount-link">
          <span className="settings-mount-bucket">{mount.bucket}</span>
          <span className="mount-link-wire mounted settings-mount-wire" aria-hidden="true" />
          <code className="settings-mount-path" title={mount.localPath}>
            {middleTruncate(mount.localPath)}
          </code>
        </div>

        <div className="settings-mount-foot">
          <div className="settings-mount-meta">
            <span
              className={['mount-tag', mount.readOnly ? '' : 'mount-tag-live'].join(' ').trim()}
            >
              {mountModeLabel(mount.readOnly)}
            </span>
            <span>Mounted {relativeMountTime(mount.mountedAt, now)}</span>
            <span className="settings-mount-dot" />
            <span className="settings-mount-account">{mount.accountId}</span>
          </div>

          <div className="settings-mount-actions">
            <button className="btn btn-sm" onClick={() => onReveal(mount)} disabled={busy}>
              <FolderOpenOutlined style={{ fontSize: 11 }} />
              {revealLabel}
            </button>
            <button className="btn btn-sm" onClick={() => onUnmount(mount)} disabled={busy}>
              <DisconnectOutlined style={{ fontSize: 11 }} />
              {busy ? 'Unmounting…' : 'Unmount'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── SettingsMountsPanel ─────────────────────────────────────────── */
export default function SettingsMountsPanel() {
  const mounts = useMountStore((s) => s.mounts);
  const unmountBucket = useMountStore((s) => s.unmount);

  const { message } = App.useApp();
  const os = useMemo(() => detectOs(), []);
  const revealLabel = useMemo(() => revealActionLabel(os), [os]);
  const now = useClock();

  // Busy is per row: unmounting one bucket must not freeze the others.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());

  const setBusy = useCallback((mountId: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(mountId);
      else next.delete(mountId);
      return next;
    });
  }, []);

  const handleReveal = useCallback(
    async (mount: MountInfo) => {
      try {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
        await revealItemInDir(mount.localPath);
      } catch {
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(mount.localPath);
        } catch (e) {
          console.error('Failed to open mount folder:', e);
          message.error('Could not open the folder');
        }
      }
    },
    [message]
  );

  const unmountOne = useCallback(
    async (mount: MountInfo) => {
      setBusy(mount.mountId, true);
      const ok = await unmountBucket(mount.mountId);
      setBusy(mount.mountId, false);
      return ok;
    },
    [setBusy, unmountBucket]
  );

  const handleUnmount = useCallback(
    async (mount: MountInfo) => {
      const ok = await unmountOne(mount);
      if (ok) message.success(`${mount.bucket} unmounted`);
      else message.error(useMountStore.getState().error || `Could not unmount ${mount.bucket}`);
    },
    [message, unmountOne]
  );

  const handleUnmountAll = useCallback(async () => {
    let done = 0;
    for (const mount of [...mounts]) {
      const ok = await unmountOne(mount);
      if (!ok) {
        message.error(useMountStore.getState().error || `Could not unmount ${mount.bucket}`);
        break;
      }
      done += 1;
    }
    if (done > 0) message.success(`Unmounted ${done} ${done === 1 ? 'bucket' : 'buckets'}`);
  }, [message, mounts, unmountOne]);

  const anyBusy = busyIds.size > 0;

  return (
    <div className="settings-section-stack">
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h3>Mounted buckets</h3>
            <p>Buckets attached to this computer as local folders.</p>
          </div>
          <div className="settings-mount-head-actions">
            {mounts.length > 0 && (
              <span className="settings-pill">
                {mounts.length} {mounts.length === 1 ? 'mount' : 'mounts'}
              </span>
            )}
            {mounts.length >= 2 && (
              <button className="btn btn-sm" onClick={handleUnmountAll} disabled={anyBusy}>
                Unmount all
              </button>
            )}
          </div>
        </div>

        {mounts.length === 0 ? (
          <div className="settings-account-empty">
            <LinkOutlined style={{ fontSize: 22, color: 'var(--text-subtle)' }} />
            <strong>Nothing mounted</strong>
            <span>
              Open a bucket&rsquo;s menu in the sidebar and choose Mount as local drive. It shows up
              here once it is live.
            </span>
          </div>
        ) : (
          <div className="settings-mount-list">
            {mounts.map((mount) => (
              <MountRow
                key={mount.mountId}
                mount={mount}
                now={now}
                busy={busyIds.has(mount.mountId)}
                revealLabel={revealLabel}
                onReveal={handleReveal}
                onUnmount={handleUnmount}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
