import { describe, expect, test } from 'bun:test';
import {
  detectOs,
  extractSudoCommand,
  joinMountPath,
  messageWithoutSudoCommand,
  mountRequirementHint,
  pathLeaf,
  pathSeparator,
  revealActionLabel,
} from './mount';

const UA = {
  macos:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

describe('detectOs', () => {
  test('reads the host OS out of each desktop webview user agent', () => {
    expect(detectOs(UA.macos)).toBe('macos');
    expect(detectOs(UA.windows)).toBe('windows');
    expect(detectOs(UA.linux)).toBe('linux');
  });

  test('falls back to linux for an unrecognised agent', () => {
    expect(detectOs('something else entirely')).toBe('linux');
  });
});

describe('per-OS copy', () => {
  test('names the file manager the way the OS does', () => {
    expect(revealActionLabel('macos')).toBe('Reveal in Finder');
    expect(revealActionLabel('windows')).toBe('Show in Explorer');
    expect(revealActionLabel('linux')).toBe('Show in Files');
  });

  test('states what each OS needs before mounting', () => {
    expect(mountRequirementHint('macos')).toContain('no extra software');
    expect(mountRequirementHint('linux')).toContain('nfs-utils');
    expect(mountRequirementHint('windows')).toContain('Not supported on Windows yet');
  });
});

describe('joinMountPath', () => {
  test('makes the bucket the leaf folder of the picked directory', () => {
    expect(joinMountPath('/Users/me/Desktop', 'photos', 'macos')).toBe('/Users/me/Desktop/photos');
  });

  test('uses backslashes on Windows', () => {
    expect(joinMountPath('C:\\Users\\me', 'photos', 'windows')).toBe('C:\\Users\\me\\photos');
  });

  test('does not double up when the pick already ends with the bucket', () => {
    expect(joinMountPath('/Users/me/CloudMounts/photos', 'photos', 'macos')).toBe(
      '/Users/me/CloudMounts/photos'
    );
  });

  test('normalises a trailing separator', () => {
    expect(joinMountPath('/Users/me/Desktop/', 'photos', 'macos')).toBe('/Users/me/Desktop/photos');
    expect(joinMountPath('C:\\', 'photos', 'windows')).toBe('C:\\photos');
  });

  test('handles the filesystem root', () => {
    expect(joinMountPath('/', 'photos', 'macos')).toBe('/photos');
  });

  test('pathSeparator matches the platform', () => {
    expect(pathSeparator('windows')).toBe('\\');
    expect(pathSeparator('macos')).toBe('/');
    expect(pathSeparator('linux')).toBe('/');
  });
});

describe('pathLeaf', () => {
  test('returns the last segment of either separator style', () => {
    expect(pathLeaf('/Users/me/CloudMounts/photos')).toBe('photos');
    expect(pathLeaf('C:\\Users\\me\\photos')).toBe('photos');
    expect(pathLeaf('/Users/me/photos/')).toBe('photos');
  });

  test('falls back to the whole string when there is no separator', () => {
    expect(pathLeaf('photos')).toBe('photos');
  });
});

describe('extractSudoCommand', () => {
  test('pulls the sudo mount line out of a multi-line error', () => {
    const error = [
      'Mounting needs elevated permissions on this system.',
      '  sudo mount -t nfs -o nolock,vers=3,port=51234 localhost:/ /mnt/photos',
      'Then retry.',
    ].join('\n');

    expect(extractSudoCommand(error)).toBe(
      'sudo mount -t nfs -o nolock,vers=3,port=51234 localhost:/ /mnt/photos'
    );
  });

  test('returns null when the error carries no command', () => {
    expect(extractSudoCommand('Bucket not found')).toBeNull();
    expect(extractSudoCommand('')).toBeNull();
    expect(extractSudoCommand(null)).toBeNull();
    expect(extractSudoCommand(undefined)).toBeNull();
  });

  test('ignores a mention of sudo that is not its own line', () => {
    expect(extractSudoCommand('try running sudo mount yourself')).toBeNull();
  });
});

describe('messageWithoutSudoCommand', () => {
  test('leaves the prose behind so the command is not shown twice', () => {
    const error = [
      'Mounting needs elevated permissions on this system.',
      '  sudo mount -t nfs -o nolock localhost:/ /mnt/photos',
      'Then retry.',
    ].join('\n');

    expect(messageWithoutSudoCommand(error)).toBe(
      'Mounting needs elevated permissions on this system.\nThen retry.'
    );
  });

  test('returns an empty string when the error was only the command', () => {
    expect(messageWithoutSudoCommand('sudo mount -t nfs localhost:/ /mnt/photos')).toBe('');
    expect(messageWithoutSudoCommand(null)).toBe('');
  });

  test('passes an unrelated error through untouched', () => {
    expect(messageWithoutSudoCommand('Bucket not found')).toBe('Bucket not found');
  });
});
