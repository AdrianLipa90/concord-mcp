import { describe, expect, it } from 'vitest';

import { upsertCodexHooks, upsertCodexMcpServer } from '../../src/install/codex-config.js';

describe('upsertCodexHooks', () => {
  it('creates the config when Codex has none', () => {
    const result = upsertCodexHooks(undefined);

    expect(result).toContain('[[hooks.SessionStart]]');
    expect(result).toContain('[[hooks.PostToolUse]]');
    expect(result).toContain('[[hooks.Stop]]');
  });

  it('is a no-op when applied twice', () => {
    const once = upsertCodexHooks('model = "gpt-5.6"\n');

    expect(upsertCodexHooks(once)).toBe(once);
  });

  it('keeps the user config it was added to', () => {
    const result = upsertCodexHooks('model = "gpt-5.6"\nnotify = ["thing"]\n');

    expect(result).toContain('model = "gpt-5.6"');
    expect(result).toContain('notify = ["thing"]');
  });

  it('appends after existing tables, so their keys are not re-parented', () => {
    const result = upsertCodexHooks('[mcp_servers.concord]\ncommand = "concord-mcp"\n');

    expect(result.indexOf('[mcp_servers.concord]')).toBeLessThan(result.indexOf('[[hooks.'));
    expect(result).toContain('command = "concord-mcp"');
  });

  it('replaces a previous block rather than stacking a second one', () => {
    const stale = upsertCodexHooks(undefined).replace(
      'concord inbox register --from-hook --provider codex',
      'concord inbox register --old-flag',
    );
    const result = upsertCodexHooks(stale);

    expect(result).not.toContain('--old-flag');
    expect(result.match(/\[\[hooks\.SessionStart\]\]/gu)).toHaveLength(1);
  });

  it('keeps hook trust that Codex appended inside the block', () => {
    // Codex writes trust into config.toml at EOF, which lands inside our fence
    // because the end marker is the last line. Losing it silently re-prompts.
    const trusted = upsertCodexHooks(undefined).replace(
      '# <<< concord hooks <<<',
      '[hooks.state."/Users/me/.codex/config.toml:session_start:0:0"]\n' +
        'trusted_hash = "sha256:abc123"\n' +
        '# <<< concord hooks <<<',
    );

    const result = upsertCodexHooks(trusted);

    expect(result).toContain('trusted_hash = "sha256:abc123"');
    expect(result).toContain('[[hooks.SessionStart]]');
  });

  it('moves preserved trust outside the fence so later rewrites cannot reach it', () => {
    const trusted = upsertCodexHooks(undefined).replace(
      '# <<< concord hooks <<<',
      '[hooks.state."x:stop:0:0"]\ntrusted_hash = "sha256:def456"\n# <<< concord hooks <<<',
    );
    const once = upsertCodexHooks(trusted);

    expect(once.indexOf('# <<< concord hooks <<<')).toBeLessThan(once.indexOf('trusted_hash'));
    // And it survives every subsequent run unchanged.
    expect(upsertCodexHooks(once)).toBe(once);
  });

  it('composes with the MCP server table without either clobbering the other', () => {
    const result = upsertCodexMcpServer(upsertCodexHooks('model = "gpt-5.6"\n'));

    expect(result).toContain('[mcp_servers.concord]');
    expect(result).toContain('[[hooks.PostToolUse]]');
    expect(result).toContain('model = "gpt-5.6"');
  });
});
