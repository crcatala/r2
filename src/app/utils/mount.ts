/**
 * Pure helpers for the bucket mount UI: host-OS detection and the per-OS copy
 * and path rules that follow from it. Kept free of React/Tauri imports so the
 * behaviour is unit-testable.
 */

export type OsKind = 'macos' | 'windows' | 'linux';

/**
 * The webview reports the host OS in its user agent — WKWebView on macOS,
 * WebView2 on Windows, WebKitGTK on Linux.
 */
export function detectOs(userAgent?: string): OsKind {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/Windows|Win64|Win32/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  return 'linux';
}

/** What the OS calls its file manager, for buttons that open one. */
export function revealActionLabel(os: OsKind): string {
  if (os === 'windows') return 'Show in Explorer';
  if (os === 'linux') return 'Show in Files';
  return 'Reveal in Finder';
}

/** One line on what mounting needs from this OS, shown before the user commits. */
export function mountRequirementHint(os: OsKind): string {
  if (os === 'windows') return 'Not supported on Windows yet.';
  if (os === 'linux') return 'Requires nfs-utils; may prompt for sudo.';
  return 'Mounts instantly — no extra software needed.';
}

export function pathSeparator(os: OsKind): string {
  return os === 'windows' ? '\\' : '/';
}

/**
 * Build a mount point inside a folder the user picked. The bucket becomes the
 * leaf folder — mount points must be their own empty directory — unless the
 * pick already ends with the bucket name.
 */
export function joinMountPath(parent: string, bucket: string, os: OsKind): string {
  const trimmed = parent.replace(/[/\\]+$/, '');
  const leaf = trimmed.split(/[/\\]/).pop();
  if (leaf === bucket) return trimmed;
  return `${trimmed}${pathSeparator(os)}${bucket}`;
}

/** The last path segment, for labelling the folder end of the mount schematic. */
export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const leaf = trimmed.split(/[/\\]/).pop();
  return leaf || path;
}

/**
 * A Linux mount that needs elevation comes back with the exact command to run.
 * Pull that line out so it can be shown as copyable code.
 */
export function extractSudoCommand(error: string | null | undefined): string | null {
  if (!error) return null;
  for (const raw of error.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('sudo mount')) return line;
  }
  return null;
}

/** The rest of the error, once the command has been lifted out into its own block. */
export function messageWithoutSudoCommand(error: string | null | undefined): string {
  if (!error) return '';
  return error
    .split('\n')
    .filter((raw) => !raw.trim().startsWith('sudo mount'))
    .join('\n')
    .trim();
}
