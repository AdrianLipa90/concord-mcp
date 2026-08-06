import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  claudeSkillsPluginPath,
  installClaudeRelayPlugin,
  packagedPluginPath,
} from '../../src/install/claude-plugin.js';

/** A stand-in package layout: <root>/plugin/concord-relay + a caller module. */
function packagedTree(): { moduleUrl: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), 'concord-pkg-'));
  const source = join(root, 'plugin', 'concord-relay');
  mkdirSync(join(source, '.claude-plugin'), { recursive: true });
  writeFileSync(join(source, '.claude-plugin', 'plugin.json'), '{"name":"concord-relay"}');
  mkdirSync(join(root, 'dist', 'cli', 'commands'), { recursive: true });
  // The real caller lives at dist/cli/commands/setup.js — three levels down.
  return {
    moduleUrl: pathToFileURL(join(root, 'dist', 'cli', 'commands', 'setup.js')).href,
    source,
  };
}

describe('installClaudeRelayPlugin', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'concord-home-'));
    env = { CLAUDE_CONFIG_DIR: join(home, '.claude') };
  });

  it('links the packaged plugin where Claude Code discovers it', () => {
    const { moduleUrl, source } = packagedTree();

    const target = installClaudeRelayPlugin(moduleUrl, env);

    expect(target).toBe(claudeSkillsPluginPath(env));
    expect(readlinkSync(target ?? '')).toBe(source);
    expect(existsSync(join(target ?? '', '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('is a no-op when run twice', () => {
    const { moduleUrl } = packagedTree();

    const first = installClaudeRelayPlugin(moduleUrl, env);
    const second = installClaudeRelayPlugin(moduleUrl, env);

    expect(second).toBe(first);
  });

  it('re-points a link left behind by an older install', () => {
    const { moduleUrl, source } = packagedTree();
    const target = claudeSkillsPluginPath(env);
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(home, 'gone'), target);

    installClaudeRelayPlugin(moduleUrl, env);

    expect(readlinkSync(target)).toBe(source);
  });

  it('leaves a real directory someone put there alone', () => {
    const { moduleUrl } = packagedTree();
    const target = claudeSkillsPluginPath(env);
    mkdirSync(join(target, '.claude-plugin'), { recursive: true });
    writeFileSync(join(target, '.claude-plugin', 'plugin.json'), '{"name":"mine"}');

    installClaudeRelayPlugin(moduleUrl, env);

    expect(readFileSync(join(target, '.claude-plugin', 'plugin.json'), 'utf8')).toContain('mine');
  });

  it('reports nothing to install when the plugin was not packaged', () => {
    const bare = mkdtempSync(join(tmpdir(), 'concord-bare-'));
    const moduleUrl = pathToFileURL(join(bare, 'dist', 'cli', 'setup.js')).href;

    expect(installClaudeRelayPlugin(moduleUrl, env)).toBeUndefined();
  });

  it('finds the plugin from any caller depth, not a fixed number of levels up', () => {
    const { source } = packagedTree();
    const root = source.replace('/plugin/concord-relay', '');

    for (const rel of ['dist/cli/setup.js', 'dist/cli/commands/setup.js', 'src/x/y/z/a.ts']) {
      expect(packagedPluginPath(pathToFileURL(join(root, rel)).href)).toBe(source);
    }
  });
});
