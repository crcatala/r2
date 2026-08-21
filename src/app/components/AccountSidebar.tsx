'use client';

import { useState, useMemo } from 'react';
import { Dropdown, App } from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  SearchOutlined,
  SwapOutlined,
  LinkOutlined,
  DisconnectOutlined,
  FolderOpenOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useAccountStore, Token, ProviderAccount } from '@/app/stores/accountStore';
import { useMountStore, findMount, type MountTarget } from '@/app/stores/mountStore';
import { detectOs, revealActionLabel } from '@/app/utils/mount';
import { useThemeStore } from '@/app/stores/themeStore';
import { useCurrentPathStore } from '@/app/stores/currentPathStore';
import { syncBucketNow, type StorageConfig } from '@/app/lib/r2cache';
import AccountTransferModal from '@/app/components/AccountTransferModal';
import {
  AccountRow,
  R2AccountChildren,
  NonR2AccountChildren,
} from '@/app/components/AccountSidebarRows';
import type { SettingsTab } from '@/app/components/SettingsModal';

interface AccountSidebarProps {
  onAddAccount: () => void;
  onEditAccount: (account: ProviderAccount) => void;
  onAddToken: (accountId: string) => void;
  onEditToken: (token: Token) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
}

export default function AccountSidebar({
  onAddAccount,
  onEditAccount,
  onAddToken,
  onEditToken,
  onOpenSettings,
}: AccountSidebarProps) {
  const accounts = useAccountStore((state) => state.accounts);
  const currentConfig = useAccountStore((state) => state.currentConfig);
  const selectR2Bucket = useAccountStore((state) => state.selectR2Bucket);
  const selectAwsBucket = useAccountStore((state) => state.selectAwsBucket);
  const selectMinioBucket = useAccountStore((state) => state.selectMinioBucket);
  const selectRustfsBucket = useAccountStore((state) => state.selectRustfsBucket);
  const deleteAccount = useAccountStore((state) => state.deleteAccount);
  const deleteAwsAccount = useAccountStore((state) => state.deleteAwsAccount);
  const deleteMinioAccount = useAccountStore((state) => state.deleteMinioAccount);
  const deleteRustfsAccount = useAccountStore((state) => state.deleteRustfsAccount);
  const deleteToken = useAccountStore((state) => state.deleteToken);

  const mounts = useMountStore((state) => state.mounts);
  const openMountModal = useMountStore((state) => state.openMountModal);
  const unmountBucket = useMountStore((state) => state.unmount);

  const sidebarStyle = useThemeStore((state) => state.sidebarStyle);
  const cycleSidebarStyle = useThemeStore((state) => state.cycleSidebarStyle);
  const setSidebarStyle = useThemeStore((state) => state.setSidebarStyle);
  const setCurrentPath = useCurrentPathStore((state) => state.setCurrentPath);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [transferModalOpen, setTransferModalOpen] = useState(false);

  const { message, modal } = App.useApp();

  const os = useMemo(() => detectOs(), []);

  const collapsed = sidebarStyle === 'collapsed';

  const sidebarCls = [
    'sidebar',
    sidebarStyle === 'collapsed' ? 'collapsed-sidebar' : '',
    sidebarStyle === 'floating' ? 'floating-sidebar' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const searchLower = search.trim().toLowerCase();

  const filteredAccounts = useMemo(() => {
    if (!searchLower) return accounts;
    return accounts.filter((a) => {
      const nameMatch =
        a.account.name?.toLowerCase().includes(searchLower) ||
        a.account.id.toLowerCase().includes(searchLower);
      if (nameMatch) return true;
      if (a.provider === 'r2') {
        return a.tokens.some(
          (td) =>
            td.token.name?.toLowerCase().includes(searchLower) ||
            td.buckets.some((b) => b.name.toLowerCase().includes(searchLower))
        );
      }
      return a.buckets.some((b) => b.name.toLowerCase().includes(searchLower));
    });
  }, [accounts, searchLower]);

  function toggleExpanded(id: string) {
    // Clicking an account icon while collapsed expands the sidebar and opens that account.
    if (sidebarStyle === 'collapsed') {
      setSidebarStyle('full');
      setExpanded((prev) => ({ ...prev, [id]: true }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function handleSelectR2Bucket(tokenId: number, bucketName: string) {
    try {
      setCurrentPath('');
      await selectR2Bucket(tokenId, bucketName);
    } catch {
      message.error('Failed to switch bucket');
    }
  }

  async function handleSelectNonR2Bucket(
    accountData: ProviderAccount & { provider: 'aws' | 'minio' | 'rustfs' },
    bucketName: string
  ) {
    try {
      setCurrentPath('');
      if (accountData.provider === 'aws') {
        await selectAwsBucket(accountData.account.id, bucketName);
      } else if (accountData.provider === 'minio') {
        await selectMinioBucket(accountData.account.id, bucketName);
      } else {
        await selectRustfsBucket(accountData.account.id, bucketName);
      }
    } catch {
      message.error('Failed to switch bucket');
    }
  }

  async function handleDeleteAccount(accountData: ProviderAccount) {
    modal.confirm({
      title: 'Delete Account',
      content:
        'Are you sure you want to delete this account? All tokens and bucket configurations will be removed.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          if (accountData.provider === 'r2') {
            await deleteAccount(accountData.account.id);
          } else if (accountData.provider === 'aws') {
            await deleteAwsAccount(accountData.account.id);
          } else if (accountData.provider === 'minio') {
            await deleteMinioAccount(accountData.account.id);
          } else {
            await deleteRustfsAccount(accountData.account.id);
          }
          message.success('Account deleted');
        } catch {
          message.error('Failed to delete account');
        }
      },
    });
  }

  async function handleDeleteToken(tokenId: number) {
    modal.confirm({
      title: 'Delete Token',
      content:
        'Are you sure you want to delete this token? All bucket configurations will be removed.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deleteToken(tokenId);
          message.success('Token deleted');
        } catch {
          message.error('Failed to delete token');
        }
      },
    });
  }

  function getAccountContextMenu(accountData: ProviderAccount): MenuProps['items'] {
    const items: MenuProps['items'] = [
      {
        key: 'edit',
        label: 'Edit Account',
        icon: <EditOutlined />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          onEditAccount(accountData);
        },
      },
    ];

    if (accountData.provider === 'r2') {
      items.push({
        key: 'add-token',
        label: 'Add Token',
        icon: <PlusOutlined />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          onAddToken(accountData.account.id);
        },
      });
    }

    items.push({
      key: 'transfer',
      label: 'Transfer accounts…',
      icon: <SwapOutlined />,
      onClick: (e) => {
        e.domEvent.stopPropagation();
        setTransferModalOpen(true);
      },
    });

    items.push({ type: 'divider' });
    items.push({
      key: 'delete',
      label: 'Delete Account',
      icon: <DeleteOutlined />,
      danger: true,
      onClick: (e) => {
        e.domEvent.stopPropagation();
        handleDeleteAccount(accountData);
      },
    });

    return items;
  }

  /**
   * Assemble mount credentials for any listed bucket: R2 keys live on the
   * token, every other provider's on the account. Endpoint/region assembly
   * mirrors toStorageConfig().
   *
   * Must stay free of select*Bucket / set_current_* — mounting a bucket may
   * never move the user's current selection as a side effect. The account and
   * token rows already hold every credential this needs.
   */
  function buildMountTarget(
    accountData: ProviderAccount,
    bucketName: string,
    token?: Token
  ): MountTarget {
    const accountLabel = accountData.account.name || accountData.account.id;

    if (accountData.provider === 'r2') {
      return {
        provider: 'r2',
        accountId: accountData.account.id,
        accountLabel,
        bucket: bucketName,
        accessKeyId: token?.access_key_id ?? '',
        secretAccessKey: token?.secret_access_key ?? '',
        region: null,
        endpointUrl: null,
        forcePathStyle: null,
      };
    }

    if (accountData.provider === 'aws') {
      const account = accountData.account;
      return {
        provider: 'aws',
        accountId: account.id,
        accountLabel,
        bucket: bucketName,
        accessKeyId: account.access_key_id,
        secretAccessKey: account.secret_access_key,
        region: account.region,
        endpointUrl: account.endpoint_host
          ? `${account.endpoint_scheme || 'https'}://${account.endpoint_host}`
          : null,
        forcePathStyle: account.force_path_style,
      };
    }

    const account = accountData.account;
    return {
      provider: accountData.provider,
      accountId: account.id,
      accountLabel,
      bucket: bucketName,
      accessKeyId: account.access_key_id,
      secretAccessKey: account.secret_access_key,
      region: null,
      endpointUrl: `${account.endpoint_scheme}://${account.endpoint_host}`,
      forcePathStyle: accountData.provider === 'rustfs' ? true : account.force_path_style,
    };
  }

  /**
   * Build a StorageConfig for any listed bucket, mirroring buildMountTarget.
   * Sync now runs against these credentials directly so it works for buckets
   * that are not currently selected.
   */
  function buildSyncConfig(
    accountData: ProviderAccount,
    bucketName: string,
    token?: Token
  ): StorageConfig {
    if (accountData.provider === 'r2') {
      return {
        provider: 'r2',
        accountId: accountData.account.id,
        bucket: bucketName,
        accessKeyId: token?.access_key_id,
        secretAccessKey: token?.secret_access_key,
      };
    }

    if (accountData.provider === 'aws') {
      const account = accountData.account;
      return {
        provider: 'aws',
        accountId: account.id,
        bucket: bucketName,
        accessKeyId: account.access_key_id,
        secretAccessKey: account.secret_access_key,
        region: account.region,
        endpointScheme: account.endpoint_scheme,
        endpointHost: account.endpoint_host ?? undefined,
        forcePathStyle: account.force_path_style,
      };
    }

    const account = accountData.account;
    return {
      provider: accountData.provider,
      accountId: account.id,
      bucket: bucketName,
      accessKeyId: account.access_key_id,
      secretAccessKey: account.secret_access_key,
      endpointScheme: account.endpoint_scheme,
      endpointHost: account.endpoint_host,
      forcePathStyle: accountData.provider === 'rustfs' ? true : account.force_path_style,
    };
  }

  async function handleSyncBucket(accountData: ProviderAccount, bucketName: string, token?: Token) {
    const config = buildSyncConfig(accountData, bucketName, token);
    if (!config.accessKeyId || !config.secretAccessKey) {
      message.error(`Missing credentials for ${bucketName} — add them in Settings to sync`);
      return;
    }
    try {
      await syncBucketNow(config);
      message.success(`Syncing ${bucketName}…`);
    } catch (e) {
      message.error(`Failed to start sync: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRevealMount(localPath: string) {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(localPath);
    } catch {
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(localPath);
      } catch (e) {
        console.error('Failed to open mount folder:', e);
        message.error('Could not open the folder');
      }
    }
  }

  async function handleUnmountBucket(mountId: string, bucketName: string) {
    const ok = await unmountBucket(mountId);
    if (ok) {
      message.success(`${bucketName} unmounted`);
    } else {
      message.error(useMountStore.getState().error || `Could not unmount ${bucketName}`);
    }
  }

  function getBucketContextMenu(
    accountData: ProviderAccount,
    bucketName: string,
    token?: Token
  ): MenuProps['items'] {
    const mount = findMount(mounts, accountData.provider, accountData.account.id, bucketName);

    // "Sync now" runs against the *selected* bucket's client, and its
    // progress/completion events are attributed to the current selection
    // (backgroundSync is global in syncStore). Only offer it for the currently
    // selected bucket to avoid stamping the wrong bucket's last-sync/counts.
    const isCurrentBucket =
      currentConfig?.provider === accountData.provider &&
      currentConfig?.account_id === accountData.account.id &&
      currentConfig?.bucket === bucketName;

    const syncItem: NonNullable<MenuProps['items']>[number] | null = isCurrentBucket
      ? {
          key: 'sync',
          label: 'Sync now',
          icon: <SyncOutlined />,
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleSyncBucket(accountData, bucketName, token);
          },
        }
      : null;

    if (mount) {
      return [
        ...(syncItem ? [syncItem] : []),
        {
          key: 'reveal',
          label: revealActionLabel(os),
          icon: <FolderOpenOutlined />,
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleRevealMount(mount.localPath);
          },
        },
        { type: 'divider' },
        {
          key: 'unmount',
          label: 'Unmount',
          icon: <DisconnectOutlined />,
          onClick: (e) => {
            e.domEvent.stopPropagation();
            handleUnmountBucket(mount.mountId, bucketName);
          },
        },
      ];
    }

    return [
      ...(syncItem ? [syncItem] : []),
      {
        key: 'mount',
        label: 'Mount as local drive',
        icon: <LinkOutlined />,
        onClick: (e) => {
          e.domEvent.stopPropagation();
          openMountModal(buildMountTarget(accountData, bucketName, token));
        },
      },
    ];
  }

  function getMountedPath(accountData: ProviderAccount, bucketName: string): string | null {
    return (
      findMount(mounts, accountData.provider, accountData.account.id, bucketName)?.localPath ?? null
    );
  }

  function getTokenContextMenu(token: Token): MenuProps['items'] {
    return [
      {
        key: 'edit',
        label: 'Edit Token',
        icon: <EditOutlined />,
        onClick: () => onEditToken(token),
      },
      { type: 'divider' },
      {
        key: 'delete',
        label: 'Delete Token',
        icon: <DeleteOutlined />,
        danger: true,
        onClick: () => handleDeleteToken(token.id),
      },
    ];
  }

  return (
    <>
      <aside className={sidebarCls}>
        {/* Standalone collapse toggle row, shown only when collapsed —
            sits between the brand and the account list */}
        {collapsed && (
          <div className="sb-collapse-rail">
            <button className="sb-icon-btn" title="Cycle sidebar style" onClick={cycleSidebarStyle}>
              <MenuFoldOutlined style={{ fontSize: 14 }} />
            </button>
          </div>
        )}

        {/* Search + collapse toggle, single row in full mode */}
        {!collapsed && (
          <div className="sb-search-row">
            <div className="sb-search">
              <SearchOutlined className="search-icon" style={{ fontSize: 13 }} />
              <input
                placeholder="Filter accounts & buckets"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button className="sb-icon-btn" title="Cycle sidebar style" onClick={cycleSidebarStyle}>
              <MenuFoldOutlined style={{ fontSize: 14 }} />
            </button>
          </div>
        )}

        {/* Section label */}
        {!collapsed && <div className="sb-section-label">Accounts</div>}

        {/* Account tree */}
        <div className="sb-scroll">
          {filteredAccounts.map((accountData) => {
            const id = accountData.account.id;
            const isExpanded = !!expanded[id];
            const isCurrentAccount =
              currentConfig?.account_id === id && currentConfig?.provider === accountData.provider;

            return (
              <div className="sb-account" key={id}>
                <AccountRow
                  accountData={accountData}
                  expanded={isExpanded}
                  collapsed={collapsed}
                  onToggle={() => toggleExpanded(id)}
                  contextMenu={getAccountContextMenu(accountData)}
                />

                {isExpanded && !collapsed && accountData.provider === 'r2' && (
                  <R2AccountChildren
                    accountData={accountData}
                    currentTokenId={currentConfig?.token_id}
                    currentBucket={currentConfig?.bucket}
                    search={searchLower}
                    onSelectBucket={handleSelectR2Bucket}
                    getTokenContextMenu={getTokenContextMenu}
                    getBucketContextMenu={(token, bucketName) =>
                      getBucketContextMenu(accountData, bucketName, token)
                    }
                    getMountedPath={(bucketName) => getMountedPath(accountData, bucketName)}
                    onOpenMounts={onOpenSettings && (() => onOpenSettings('mounts'))}
                  />
                )}

                {isExpanded && !collapsed && accountData.provider !== 'r2' && (
                  <NonR2AccountChildren
                    accountData={
                      accountData as ProviderAccount & {
                        provider: 'aws' | 'minio' | 'rustfs';
                      }
                    }
                    currentBucket={currentConfig?.bucket}
                    isCurrentAccount={isCurrentAccount}
                    search={searchLower}
                    onSelectBucket={(bucketName) =>
                      handleSelectNonR2Bucket(
                        accountData as ProviderAccount & {
                          provider: 'aws' | 'minio' | 'rustfs';
                        },
                        bucketName
                      )
                    }
                    getBucketContextMenu={(bucketName) =>
                      getBucketContextMenu(accountData, bucketName)
                    }
                    getMountedPath={(bucketName) => getMountedPath(accountData, bucketName)}
                    onOpenMounts={onOpenSettings && (() => onOpenSettings('mounts'))}
                  />
                )}
              </div>
            );
          })}

          {filteredAccounts.length === 0 && !collapsed && (
            <div
              style={{
                padding: '16px 12px',
                fontSize: 12,
                color: 'var(--text-subtle)',
                textAlign: 'center',
              }}
            >
              {searchLower ? 'No matching accounts' : 'No accounts yet'}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sb-footer">
          <button
            className="sb-footer-btn"
            onClick={() => onOpenSettings?.('account') ?? onAddAccount()}
            title={collapsed ? 'Add account' : undefined}
          >
            <PlusOutlined style={{ fontSize: collapsed ? 15 : 11 }} />
            {!collapsed && <span>Add account</span>}
          </button>
          <button
            className="sb-icon-btn"
            onClick={() => onOpenSettings?.('account')}
            title="Settings"
            style={collapsed ? undefined : { width: 30, height: 30 }}
          >
            <SettingOutlined style={{ fontSize: collapsed ? 16 : 14 }} />
          </button>
        </div>
      </aside>

      {transferModalOpen && (
        <AccountTransferModal open={true} onClose={() => setTransferModalOpen(false)} />
      )}
    </>
  );
}

// Re-export types from store for convenience
export type {
  Account,
  Token,
  Bucket,
  TokenWithBuckets,
  AccountWithTokens,
  CurrentConfig,
  AwsAccount,
  MinioAccount,
  AwsBucket,
  MinioBucket,
  ProviderAccount,
} from '@/app/stores/accountStore';
