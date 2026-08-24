import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type AvailableUpdate,
  checkForUpdate,
  findAvailableUpdate,
  formatUpdateNotice,
  isNewerVersion,
  startBackgroundUpdateCheck,
} from '../../src/update-notifier.js';

function cacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'concord-update-')), 'cache.json');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isNewerVersion', () => {
  it('compares stable semantic versions', () => {
    expect(isNewerVersion('0.4.0', '0.4.1')).toBe(true);
    expect(isNewerVersion('0.4.9', '0.5.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true);
    expect(isNewerVersion('0.4.0', '0.4.0')).toBe(false);
    expect(isNewerVersion('0.5.0', '0.4.9')).toBe(false);
  });

  it('treats a stable release as newer than its prerelease', () => {
    expect(isNewerVersion('0.5.0-beta.1', '0.5.0')).toBe(true);
    expect(isNewerVersion('0.5.0', '0.5.0-beta.1')).toBe(false);
    expect(isNewerVersion('not-semver', '0.5.0')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns a newer registry version and caches it', async () => {
    const path = cacheFile();
    let calls = 0;
    const fetchLatest = (): Promise<string> => {
      calls += 1;
      return Promise.resolve('0.5.0');
    };

    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        now: 1_000,
        fetchLatest,
      }),
    ).resolves.toBe('0.5.0');
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        now: 2_000,
        fetchLatest,
      }),
    ).resolves.toBe('0.5.0');
    expect(calls).toBe(1);
  });

  it('does not notify when the installed version is current', async () => {
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: cacheFile(),
        fetchLatest: () => Promise.resolve('0.4.0'),
      }),
    ).resolves.toBeUndefined();
  });

  it('caches a failed best-effort check to avoid repeated network delays', async () => {
    const path = cacheFile();
    let calls = 0;
    const fetchLatest = (): Promise<null> => {
      calls += 1;
      return Promise.resolve(null);
    };

    await checkForUpdate({
      currentVersion: '0.4.0',
      cacheFile: path,
      now: 1_000,
      fetchLatest,
    });
    await checkForUpdate({
      currentVersion: '0.4.0',
      cacheFile: path,
      now: 2_000,
      fetchLatest,
    });
    expect(calls).toBe(1);
  });

  it('recovers from an invalid cache file', async () => {
    const path = cacheFile();
    writeFileSync(path, 'not-json');
    await expect(
      checkForUpdate({
        currentVersion: '0.4.0',
        cacheFile: path,
        fetchLatest: () => Promise.resolve('0.4.1'),
      }),
    ).resolves.toBe('0.4.1');
  });
});

describe('formatUpdateNotice', () => {
  it('includes the versions and global npm update command', () => {
    const notice = formatUpdateNotice('0.4.0', '0.4.1');
    expect(notice).toContain('Concord 0.4.0 → 0.4.1');
    expect(notice).toContain('npm install -g @concord-ai/concord-mcp@latest');
  });
});

describe('findAvailableUpdate', () => {
  it('uses an Accept header supported by the npm latest-version endpoint', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'concord-update-fetch-'));
    const fetchMock = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(url).toBe('https://registry.npmjs.org/@concord-ai%2fconcord-mcp/latest');
        expect(init?.headers).toEqual({ accept: 'application/json' });
        return Promise.resolve(
          new Response(JSON.stringify({ version: '0.5.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      findAvailableUpdate('0.4.0', { XDG_CACHE_HOME: cacheRoot }),
    ).resolves.toMatchObject({
      latestVersion: '0.5.0',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the cached release metadata used by background MCP sessions', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'concord-update-root-'));
    const concordCache = join(cacheRoot, 'concord');
    mkdirSync(concordCache);
    writeFileSync(
      join(concordCache, 'update-check.json'),
      `${JSON.stringify({ checkedAt: Date.now(), latestVersion: '0.5.0' })}\n`,
    );

    await expect(findAvailableUpdate('0.4.0', { XDG_CACHE_HOME: cacheRoot })).resolves.toEqual({
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      command: 'npm install -g @concord-ai/concord-mcp@latest',
    });
  });

  it('skips background checks in CI or when explicitly disabled', async () => {
    await expect(findAvailableUpdate('0.4.0', { CI: '1' })).resolves.toBeUndefined();
    await expect(
      findAvailableUpdate('0.4.0', { CONCORD_NO_UPDATE_CHECK: '1' }),
    ).resolves.toBeUndefined();
  });
});

describe('startBackgroundUpdateCheck', () => {
  it('returns immediately and exposes the result after the background check finishes', async () => {
    let finish: ((update: AvailableUpdate | undefined) => void) | undefined;
    const resolver = (): Promise<AvailableUpdate | undefined> =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const check = startBackgroundUpdateCheck('0.4.0', {}, resolver);

    expect(check.getAvailableUpdate()).toBeUndefined();
    finish?.({
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      command: 'npm install -g @concord-ai/concord-mcp@latest',
    });
    await check.done;
    expect(check.getAvailableUpdate()?.latestVersion).toBe('0.5.0');
  });
});
