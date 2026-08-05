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

  it('composes with the MCP server table without either clobbering the other', () => {
    const result = upsertCodexMcpServer(upsertCodexHooks('model = "gpt-5.6"\n'));

    expect(result).toContain('[mcp_servers.concord]');
    expect(result).toContain('[[hooks.PostToolUse]]');
    expect(result).toContain('model = "gpt-5.6"');
  });
});
