import { describe, expect, it } from 'vitest';

import { resolveAgentId, sessionStartAgentId } from '../../src/cli/agent-identity.js';

describe('resolveAgentId', () => {
  it('derives identity from the session alone, so plain `claude` needs no setup', () => {
    expect(resolveAgentId(undefined, { CLAUDE_CODE_SESSION_ID: 'a1b2c3d4-e5f6-7890' })).toBe(
      'claude-code:a1b2c3d4',
    );
  });

  it('gives a monitor and a hook in one session the same identity', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'a1b2c3d4-e5f6-7890' };

    expect(resolveAgentId(undefined, env)).toBe(sessionStartAgentId('a1b2c3d4-e5f6-7890', env));
  });

  it('prefers an operator-chosen name over the generated slug', () => {
    expect(
      resolveAgentId(undefined, {
        CONCORD_AGENT_ID: 'alpha',
        CLAUDE_CODE_SESSION_ID: 'a1b2c3d4-e5f6-7890',
      }),
    ).toBe('alpha');
  });

  it('lets an explicit flag win over both', () => {
    expect(resolveAgentId('reviewer', { CONCORD_AGENT_ID: 'alpha' })).toBe('reviewer');
  });

  it('ignores blank values rather than registering an unnamed agent', () => {
    expect(resolveAgentId('  ', { CONCORD_AGENT_ID: 'alpha' })).toBe('alpha');
  });

  it('explains itself when run outside any session', () => {
    expect(() => resolveAgentId(undefined, {})).toThrow(/Could not tell which agent/);
  });
});
