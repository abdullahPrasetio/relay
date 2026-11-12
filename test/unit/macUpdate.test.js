import { describe, expect, it } from 'vitest';
import {
  buildInstallerScript,
  checkMacUpdate,
  compareVersions,
  parseLatestMacYml,
  pickMacAsset,
} from '../../electron/macUpdate.js';

const YML = `version: 0.11.0
files:
  - url: Relay-0.11.0-mac-arm64.zip
    sha512: arm-sha
    size: 123
  - url: Relay-0.11.0-mac-universal.zip
    sha512: universal-sha
    size: 456
path: Relay-0.11.0-mac-arm64.zip
sha512: arm-sha
`;

function release() {
  return {
    tag_name: 'v0.11.0',
    html_url: 'https://github.test/release',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url: 'https://github.test/latest-mac.yml',
      },
      {
        name: 'Relay-0.11.0-mac-arm64.zip',
        browser_download_url: 'https://github.test/arm.zip',
        size: 123,
      },
      {
        name: 'Relay-0.11.0-mac-universal.zip',
        browser_download_url: 'https://github.test/universal.zip',
        size: 456,
      },
    ],
  };
}

describe('compareVersions', () => {
  it('compares numeric components', () => {
    expect(compareVersions('0.11.0', '0.10.1')).toBe(1);
    expect(compareVersions('v0.11.0', '0.11.0')).toBe(0);
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1);
  });
});

describe('parseLatestMacYml', () => {
  it('extracts versions, urls, checksums and sizes', () => {
    expect(parseLatestMacYml(YML)).toEqual({
      version: '0.11.0',
      files: [
        { url: 'Relay-0.11.0-mac-arm64.zip', sha512: 'arm-sha', size: 123 },
        { url: 'Relay-0.11.0-mac-universal.zip', sha512: 'universal-sha', size: 456 },
      ],
    });
  });
});

describe('pickMacAsset', () => {
  it('prefers the architecture-specific zip and falls back to universal', () => {
    expect(pickMacAsset(release(), 'arm64').name).toBe('Relay-0.11.0-mac-arm64.zip');
    expect(pickMacAsset(release(), 'x64').name).toBe('Relay-0.11.0-mac-universal.zip');
  });
});

describe('checkMacUpdate', () => {
  it('returns download metadata for a newer release', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => release(),
      text: async () => YML,
    });
    const result = await checkMacUpdate({
      currentVersion: '0.10.1',
      arch: 'arm64',
      fetchImpl,
    });
    expect(result).toMatchObject({
      available: true,
      version: '0.11.0',
      assetName: 'Relay-0.11.0-mac-arm64.zip',
      url: 'https://github.test/arm.zip',
      sha512: 'arm-sha',
      size: 123,
    });
  });

  it('does not report the current version as an update', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => release(),
      text: async () => YML,
    });
    await expect(
      checkMacUpdate({ currentVersion: '0.11.0', arch: 'arm64', fetchImpl })
    ).resolves.toEqual({ available: false, version: '0.11.0' });
  });
});

describe('buildInstallerScript', () => {
  it('waits for the old process and keeps a backup', () => {
    const script = buildInstallerScript({
      appPath: "/Applications/Relay's.app",
      zipPath: '/tmp/update.zip',
      pid: 42,
    });
    expect(script).toContain('PID=42');
    expect(script).toContain("'/Applications/Relay'\\''s.app'");
    expect(script).toContain('.relay-backup');
    expect(script).toContain('xattr -dr com.apple.quarantine');
    expect(script).toContain('/usr/bin/open "$APP"');
  });
});
