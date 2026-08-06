import { describe, expect, test, mock, beforeEach } from 'bun:test';

/**
 * Store-level contract for the bucket mount feature. The backend owns the
 * truth (`list_mounts` + the `mount-changed` event); these tests pin the
 * state transitions the UI reads: busy flags, the snake_case → camelCase
 * mapping, error capture, and mount/unmount bookkeeping.
 */

type InvokeArgs = Record<string, unknown> | undefined;
type InvokeFn = (cmd: string, args?: InvokeArgs) => Promise<unknown>;
type EventHandler = (event: { payload: unknown }) => void;

// Reassigned per test; the module mocks close over these bindings by
// reference, so each test installs its own fake backend.
let handleInvoke: InvokeFn = async () => undefined;

// Subscriptions outlive individual tests: setupGlobalMountListeners() guards
// against re-subscribing, so the handler registered by the first call is the
// one every later test drives.
const eventHandlers: Record<string, EventHandler> = {};
let listenCalls = 0;

mock.module('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: InvokeArgs) => handleInvoke(cmd, args),
}));

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: EventHandler) => {
    listenCalls += 1;
    eventHandlers[event] = handler;
    return () => delete eventHandlers[event];
  },
}));

// Import after the mocks are registered so the store binds to the fakes.
const {
  useMountStore,
  setupGlobalMountListeners,
  findMount,
  isBucketMounted,
  toMountInfo,
  defaultMountPath,
} = await import('./mountStore');

function payload(overrides: Record<string, unknown> = {}) {
  return {
    mount_id: 'm-1',
    provider: 'r2' as const,
    account_id: 'acc-1',
    bucket: 'photos',
    local_path: '/Users/me/CloudMounts/photos',
    port: 51234,
    read_only: true,
    mounted_at: 1_700_000_000,
    ...overrides,
  };
}

const MOUNT_INPUT = {
  provider: 'r2' as const,
  account_id: 'acc-1',
  bucket: 'photos',
  local_path: '/Users/me/CloudMounts/photos',
  access_key_id: 'ak',
  secret_access_key: 'sk',
};

beforeEach(() => {
  handleInvoke = async () => undefined;
  useMountStore.setState({
    mounts: [],
    modalOpen: false,
    target: null,
    isMounting: false,
    isUnmounting: false,
    error: null,
  });
});

describe('payload mapping', () => {
  test('maps every snake_case field onto its camelCase counterpart', () => {
    expect(toMountInfo(payload())).toEqual({
      mountId: 'm-1',
      provider: 'r2',
      accountId: 'acc-1',
      bucket: 'photos',
      localPath: '/Users/me/CloudMounts/photos',
      port: 51234,
      readOnly: true,
      mountedAt: 1_700_000_000,
    });
  });
});

describe('modal state', () => {
  const target = {
    provider: 'aws' as const,
    accountId: 'aws-1',
    accountLabel: 'Prod',
    bucket: 'assets',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
    region: 'us-east-1',
  };

  test('opening carries the target through and clears a stale error', () => {
    useMountStore.setState({ error: 'previous failure' });
    useMountStore.getState().openMountModal(target);

    const state = useMountStore.getState();
    expect(state.modalOpen).toBe(true);
    expect(state.target).toEqual(target);
    expect(state.error).toBeNull();
  });

  test('closing drops the error but keeps the target for the closing animation', () => {
    useMountStore.getState().openMountModal(target);
    useMountStore.setState({ error: 'boom' });
    useMountStore.getState().closeMountModal();

    expect(useMountStore.getState().modalOpen).toBe(false);
    expect(useMountStore.getState().error).toBeNull();
  });
});

describe('refreshMounts', () => {
  test('replaces the list with what the backend reports', async () => {
    handleInvoke = async (cmd) => (cmd === 'list_mounts' ? [payload()] : undefined);

    await useMountStore.getState().refreshMounts();

    expect(useMountStore.getState().mounts.length).toBe(1);
    expect(useMountStore.getState().mounts[0].localPath).toBe('/Users/me/CloudMounts/photos');
  });

  test('leaves the last known list alone when the backend errors', async () => {
    useMountStore.setState({ mounts: [toMountInfo(payload())] });
    handleInvoke = async () => {
      throw 'backend unavailable';
    };

    await useMountStore.getState().refreshMounts();

    expect(useMountStore.getState().mounts.length).toBe(1);
  });
});

describe('mount', () => {
  test('sends the input under an `input` key and records the returned mount', async () => {
    let sent: InvokeArgs;
    handleInvoke = async (cmd, args) => {
      if (cmd !== 'mount_bucket') return undefined;
      sent = args;
      return payload();
    };

    const info = await useMountStore.getState().mount(MOUNT_INPUT);

    expect((sent as { input: unknown }).input).toEqual(MOUNT_INPUT);
    expect(info?.mountId).toBe('m-1');
    expect(useMountStore.getState().mounts.length).toBe(1);
    expect(useMountStore.getState().isMounting).toBe(false);
    expect(useMountStore.getState().error).toBeNull();
  });

  test('is busy while the backend works and settles afterwards', async () => {
    let release: (value: unknown) => void = () => {};
    handleInvoke = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const pending = useMountStore.getState().mount(MOUNT_INPUT);
    expect(useMountStore.getState().isMounting).toBe(true);

    release(payload());
    await pending;
    expect(useMountStore.getState().isMounting).toBe(false);
  });

  test('keeps a string error verbatim so the sudo hint survives', async () => {
    const backendError =
      'Mounting needs elevated permissions.\nsudo mount -t nfs -o nolock localhost:/ /mnt/photos';
    handleInvoke = async () => {
      throw backendError;
    };

    const info = await useMountStore.getState().mount(MOUNT_INPUT);

    expect(info).toBeNull();
    expect(useMountStore.getState().error).toBe(backendError);
    expect(useMountStore.getState().isMounting).toBe(false);
    expect(useMountStore.getState().mounts.length).toBe(0);
  });

  test('replaces an existing entry rather than duplicating the same mount id', async () => {
    useMountStore.setState({ mounts: [toMountInfo(payload({ local_path: '/old' }))] });
    handleInvoke = async () => payload({ local_path: '/new' });

    await useMountStore.getState().mount(MOUNT_INPUT);

    expect(useMountStore.getState().mounts.length).toBe(1);
    expect(useMountStore.getState().mounts[0].localPath).toBe('/new');
  });
});

describe('unmount', () => {
  test('drops the mount and reports success', async () => {
    useMountStore.setState({
      mounts: [toMountInfo(payload()), toMountInfo(payload({ mount_id: 'm-2', bucket: 'docs' }))],
    });
    let sent: InvokeArgs;
    handleInvoke = async (cmd, args) => {
      if (cmd === 'unmount_bucket') sent = args;
      return undefined;
    };

    const ok = await useMountStore.getState().unmount('m-1');

    expect(ok).toBe(true);
    expect(sent).toEqual({ mountId: 'm-1' });
    expect(useMountStore.getState().mounts.map((m) => m.mountId)).toEqual(['m-2']);
    expect(useMountStore.getState().isUnmounting).toBe(false);
  });

  test('keeps the mount listed when the backend refuses', async () => {
    useMountStore.setState({ mounts: [toMountInfo(payload())] });
    handleInvoke = async () => {
      throw 'Device busy';
    };

    const ok = await useMountStore.getState().unmount('m-1');

    expect(ok).toBe(false);
    expect(useMountStore.getState().mounts.length).toBe(1);
    expect(useMountStore.getState().error).toBe('Device busy');
    expect(useMountStore.getState().isUnmounting).toBe(false);
  });
});

describe('mount-changed subscription', () => {
  test('setup loads the current list and then follows the event', async () => {
    handleInvoke = async (cmd) => (cmd === 'list_mounts' ? [payload()] : undefined);

    await setupGlobalMountListeners();

    expect(useMountStore.getState().mounts.length).toBe(1);
    expect(typeof eventHandlers['mount-changed']).toBe('function');

    eventHandlers['mount-changed']({
      payload: { mounts: [payload({ mount_id: 'm-9', bucket: 'docs' })] },
    });

    const mounts = useMountStore.getState().mounts;
    expect(mounts.length).toBe(1);
    expect(mounts[0].mountId).toBe('m-9');
    expect(mounts[0].bucket).toBe('docs');
  });

  test('an empty event clears every mount', async () => {
    await setupGlobalMountListeners();
    useMountStore.setState({ mounts: [toMountInfo(payload())] });

    eventHandlers['mount-changed']({ payload: { mounts: [] } });

    expect(useMountStore.getState().mounts.length).toBe(0);
  });

  test('calling setup again does not subscribe a second time', async () => {
    await setupGlobalMountListeners();
    const before = listenCalls;
    await setupGlobalMountListeners();

    expect(listenCalls).toBe(before);
    expect(before).toBe(1);
  });
});

describe('selectors', () => {
  const mounts = [
    toMountInfo(payload()),
    toMountInfo(
      payload({ mount_id: 'm-2', provider: 'aws', account_id: 'aws-1', bucket: 'photos' })
    ),
  ];

  test('findMount keys on provider, account and bucket together', () => {
    expect(findMount(mounts, 'r2', 'acc-1', 'photos')?.mountId).toBe('m-1');
    expect(findMount(mounts, 'aws', 'aws-1', 'photos')?.mountId).toBe('m-2');
    // Same bucket name under a different account is a different bucket.
    expect(findMount(mounts, 'r2', 'acc-2', 'photos')).toBeUndefined();
    expect(findMount(mounts, 'r2', 'acc-1', 'docs')).toBeUndefined();
  });

  test('isBucketMounted answers the sidebar marker question', () => {
    expect(isBucketMounted(mounts, 'r2', 'acc-1', 'photos')).toBe(true);
    expect(isBucketMounted(mounts, 'minio', 'acc-1', 'photos')).toBe(false);
    expect(isBucketMounted([], 'r2', 'acc-1', 'photos')).toBe(false);
  });
});

describe('defaultMountPath', () => {
  test('asks the backend for the suggested path', async () => {
    let sent: InvokeArgs;
    handleInvoke = async (cmd, args) => {
      if (cmd !== 'default_mount_path') return undefined;
      sent = args;
      return '/Users/me/CloudMounts/photos';
    };

    expect(await defaultMountPath('photos')).toBe('/Users/me/CloudMounts/photos');
    expect(sent).toEqual({ bucket: 'photos' });
  });
});
