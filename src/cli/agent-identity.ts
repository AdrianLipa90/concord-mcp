import { randomBytes } from 'node:crypto';

import { z } from 'zod';

/** The one field we need from any client's hook payload. */
const hookSessionSchema = z.object({ session_id: z.string().optional() }).loose();

/**
 * Pull the session id out of a hook payload.
 *
 * Codex passes its session id on stdin rather than in the environment, so a
 * Codex hook has no other way to say which agent it is. Never throws: a hook
 * that cannot identify itself should fall through to the other strategies
 * rather than fail the tool call it is attached to.
 */
export function hookSessionId(rawJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  const result = hookSessionSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const sessionId = result.data.session_id?.trim();
  return sessionId === undefined || sessionId === '' ? undefined : sessionId;
}

/** `codex:019fd356` — a stable agent id for one session of one client. */
export function agentIdForSession(kind: string, sessionId: string | undefined): string {
  const slug = (sessionId ?? '')
    .replace(/[^0-9a-z]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  return `${kind}:${slug === '' ? randomBytes(4).toString('hex') : slug}`;
}

/**
 * A stable per-session agent id for Claude Code. Derived from the session id so
 * the same session always maps to the same identity (SessionStart is idempotent
 * via upsert); falls back to a random suffix when no session id is provided.
 *
 * An operator-supplied `CONCORD_AGENT_ID` wins, so a human coordinating agents
 * can name them ("alpha", "reviewer") instead of reading generated slugs.
 */
export function sessionStartAgentId(
  sessionId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env['CONCORD_AGENT_ID']?.trim();
  if (explicit !== undefined && explicit !== '') return explicit;
  return agentIdForSession('claude-code', sessionId);
}

/**
 * Work out which agent a CLI invocation is acting as, without being told.
 *
 * Hooks receive the session id in their stdin payload, but a plugin monitor
 * does not — it only has its environment. Claude Code exports
 * `CLAUDE_CODE_SESSION_ID` to both, and deriving from it here is what lets the
 * relay work in a session started as plain `claude`, with nothing to configure.
 */
export function resolveAgentId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { kind?: string; hookPayload?: string } = {},
): string {
  const given = explicit?.trim();
  if (given !== undefined && given !== '') return given;

  const configured = env['CONCORD_AGENT_ID']?.trim();
  if (configured !== undefined && configured !== '') return configured;

  const kind = options.kind ?? 'claude-code';

  // Codex only reveals its session id on stdin, so a payload wins over the
  // environment: a Codex hook run from inside a Claude Code session would
  // otherwise inherit CLAUDE_CODE_SESSION_ID and answer as the wrong agent.
  if (options.hookPayload !== undefined) {
    const fromHook = hookSessionId(options.hookPayload);
    if (fromHook !== undefined) return agentIdForSession(kind, fromHook);
  }

  const sessionId = env['CLAUDE_CODE_SESSION_ID']?.trim();
  if (sessionId !== undefined && sessionId !== '') return agentIdForSession(kind, sessionId);

  throw new Error(
    'Could not tell which agent this is. Run inside a Claude Code or Codex session, pass ' +
      '--agent <id>, or set CONCORD_AGENT_ID.',
  );
}
