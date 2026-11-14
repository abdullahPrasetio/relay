import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASES_URL,
  buildInstallerScript,
  checkMacUpdate,
  cleanupStaleUpdateFiles,
  downloadToFile,
  compareVersions,
  parseLatestMacYml,
  pickMacAsset,
  selectMacRelease,
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

function betaRelease(version = '0.12.0-beta.2') {
  return {
    tag_name: `v${version}`,
    html_url: 'https://github.test/beta',
    draft: false,
    prerelease: true,
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url: 'https://github.test/latest-mac-beta.yml',
      },
      {
        name: `Relay-${version}-mac-arm64.zip`,
        browser_download_url: 'https://github.test/beta-arm.zip',
        size: 789,
      },
    ],
  };
}

const BETA_YML = `version: 0.12.0-beta.2
files:
  - url: Relay-0.12.0-beta.2-mac-arm64.zip
    sha512: beta-sha
    size: 789
path: Relay-0.12.0-beta.2-mac-arm64.zip
sha512: beta-sha
`;

describe('compareVersions', () => {
  it('compares numeric components', () => {
    expect(compareVersions('0.11.0', '0.10.1')).toBe(1);
    expect(compareVersions('v0.11.0', '0.11.0')).toBe(0);
    expect(compareVersions('0.9.9', '0.10.0')).toBe(-1);
  });
});

describe('selectMacRelease', () => {
  it('includes prereleases only on the beta channel', () => {
    const stable = release();
    const beta = betaRelease();
    expect(
      selectMacRelease([stable, beta], { currentVersion: '0.10.0', channel: 'stable' }).version
    ).toBe('0.11.0');
    expect(
      selectMacRelease([stable, beta], { currentVersion: '0.10.0', channel: 'beta' }).version
    ).toBe('0.12.0-beta.2');
    expect(
      selectMacRelease([beta], { currentVersion: '0.12.0-beta.2', channel: 'beta' })
    ).toBeNull();
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

  it('finds a prerelease through the beta release list', async () => {
    const fetchImpl = async (url) => {
      if (url === RELEASES_URL) {
        return { ok: true, json: async () => [release(), betaRelease()] };
      }
      if (url.includes('latest-mac-beta.yml')) {
        return { ok: true, text: async () => BETA_YML };
      }
      throw new Error(`unexpected url ${url}`);
    };
    await expect(
      checkMacUpdate({ currentVersion: '0.11.0', arch: 'arm64', channel: 'beta', fetchImpl })
    ).resolves.toMatchObject({
      available: true,
      version: '0.12.0-beta.2',
      channel: 'beta',
      prerelease: true,
      sha512: 'beta-sha',
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
    ).resolves.toEqual({ available: false, version: '0.11.0', channel: 'stable' });
  });
});

describe('downloadToFile', () => {
  it('removes a partial file when the stream fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-update-test-'));
    const destination = path.join(dir, 'partial.zip');
    const fetchImpl = async () => ({
      ok: true,
      headers: { get: () => null },
      body: (async function* body() {
        yield Buffer.from('partial');
        throw new Error('stream failed');
      })(),
    });
    try {
      await expect(downloadToFile('https://example.test/update.zip', destination, { fetchImpl }))
        .rejects.toThrow('stream failed');
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cleanupStaleUpdateFiles', () => {
  it('removes only old updater leftovers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-update-stale-'));
    const oldZip = path.join(dir, 'relay-update-1.0.0-1.zip');
    const oldScript = path.join(dir, 'relay-install-1.0.0-1.sh');
    const fresh = path.join(dir, 'relay-update-1.0.0-2.zip');
    const unrelated = path.join(dir, 'keep-me.txt');
    for (const file of [oldZip, oldScript, fresh, unrelated]) fs.writeFileSync(file, 'x');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldZip, old, old);
    fs.utimesSync(oldScript, old, old);
    try {
      expect(cleanupStaleUpdateFiles(dir)).toBe(2);
      expect(fs.existsSync(oldZip)).toBe(false);
      expect(fs.existsSync(oldScript)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain('/bin/rm -f "$ZIP" "$SCRIPT"');
  });
});
