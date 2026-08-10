import { describe, expect, it } from 'vitest';

import { resolveAgentId, sessionStartIdentity } from '../../src/cli/agent-identity.js';
import { UNRESOLVED_IDENTITY_MESSAGE } from '../../src/domain/identity.js';

const SESSION = 'a1b2c3d4-e5f6-7890';

describe('resolveAgentId', () => {
  it('derives identity from the session alone, so plain `claude` needs no setup', () => {
    expect(resolveAgentId(undefined, { CLAUDE_CODE_SESSION_ID: SESSION })).toMatch(
      /^claude-code:[0-9a-f]{8}$/,
    );
  });

  it('gives a monitor and a hook in one session the same identity', () => {
    const env = { CLAUDE_CODE_SESSION_ID: SESSION };

    expect(resolveAgentId(undefined, env)).toBe(sessionStartIdentity(SESSION, env)?.agentId);
  });

  it('prefers an operator-chosen name over the generated slug', () => {
    expect(
      resolveAgentId(undefined, {
        CONCORD_AGENT_ID: 'alpha',
        CLAUDE_CODE_SESSION_ID: SESSION,
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
    expect(() => resolveAgentId(undefined, {})).toThrow(UNRESOLVED_IDENTITY_MESSAGE);
  });
});

describe('sessionStartIdentity', () => {
  it('matches the id derived from the same session id in the environment', () => {
    const fromPayload = sessionStartIdentity(SESSION, {});
    const fromEnv = sessionStartIdentity(undefined, { CLAUDE_CODE_SESSION_ID: SESSION });

    expect(fromPayload?.agentId).toBe(fromEnv?.agentId);
  });

  it('falls back to the environment when the payload carries no session id', () => {
    expect(sessionStartIdentity(undefined, { CLAUDE_CODE_SESSION_ID: SESSION })?.agentId).toMatch(
      /^claude-code:[0-9a-f]{8}$/,
    );
  });

  it('has no identity to offer when neither the payload nor the environment names one', () => {
    expect(sessionStartIdentity(undefined, {})).toBeUndefined();
  });
});
