import { readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';
import { z } from 'zod';

import type { Repositories } from '../../db/index.js';
import { UNRESOLVED_IDENTITY_MESSAGE } from '../../domain/identity.js';
import { buildRoster } from '../../domain/presence.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { sessionStartIdentity } from '../agent-identity.js';
import { openContext } from '../context.js';
import { checkFileOverlaps } from './check.js';
import { registerPullEndpoint } from './inbox.js';

/** The subset of Claude Code's PreToolUse payload we need: the edited file path.
 * Everything else is passed through and ignored. */
const preToolUsePayloadSchema = z
  .object({
    tool_input: z.object({ file_path: z.string().optional() }).loose().optional(),
  })
  .loose();

export interface HookDecision {
  /** True → deny the tool call (exit 2). */
  block: boolean;
  /** Message for stderr (shown to the agent); empty when there is nothing to say. */
  message: string;
}

/**
 * Decide whether a Claude Code PreToolUse event (Edit/Write/MultiEdit) should be
 * blocked because the edited file is claimed by another active task.
 *
 * `selfTaskId` (from `$CONCORD_TASK`) excludes your own claim. Without it we
 * cannot tell your own files apart from a real conflict, so we advise but never
 * block — blocking an agent from editing its own claimed files would be worse
 * than the problem this guards against.
 */
export function decidePreToolUse(
  repos: Repositories,
  rawJson: string,
  selfTaskId?: string,
): HookDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { block: false, message: '' };
  }
  const payload = preToolUsePayloadSchema.parse(parsed);
  const filePath = payload.tool_input?.file_path;
  if (filePath === undefined || filePath === '') {
    return { block: false, message: '' };
  }

  const overlaps = checkFileOverlaps(repos, [filePath], selfTaskId);
  if (overlaps.length === 0) {
    return { block: false, message: '' };
  }

  const detail = overlaps.map((overlap) => `${overlap.taskId} (${overlap.title})`).join(', ');
  if (selfTaskId === undefined) {
    return {
      block: false,
      message: `Concord: ${filePath} is also claimed by ${detail}. Set CONCORD_TASK=<your task id> to block colliding edits.`,
    };
  }
  return {
    block: true,
    message: `Concord: ${filePath} is claimed by another active task (${detail}). Coordinate or update your claim before editing.`,
  };
}

/** The subset of Claude Code's SessionStart payload we use. */
const sessionStartPayloadSchema = z
  .object({
    session_id: z.string().optional(),
    cwd: z.string().optional(),
  })
  .loose();

export { sessionStartIdentity };

export interface SessionStartResult {
  /** Undefined when no session id was available to derive an identity from. */
  agentId: string | undefined;
  /** Context printed to stdout, which Claude Code injects into the session. */
  message: string;
}

/**
 * Register this Claude Code session before — or even if — the model calls
 * `start_work`, then tell it the `agent_id` and who else is active. Reads a
 * SessionStart JSON payload.
 */
export function handleSessionStart(repos: Repositories, rawJson: string): SessionStartResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }
  const payload = sessionStartPayloadSchema.parse(parsed);
  const identity = sessionStartIdentity(payload.session_id);
  if (identity === undefined) {
    return { agentId: undefined, message: `Concord: ${UNRESOLVED_IDENTITY_MESSAGE}` };
  }
  const agentId = identity.agentId;

  ensureAgentRegistered(repos, identity, payload.cwd ?? null);

  // Advertise the session as reachable before any tool call, so a peer that
  // messages it early gets its message queued rather than rejected.
  registerPullEndpoint(repos, agentId, identity.kind);

  const others = buildRoster(repos.agents.list(), Date.now()).filter(
    (entry) => entry.agentId !== agentId,
  );
  const lines = [
    `Concord: this session is agent \`${agentId}\`. Concord resolves that identity from your ` +
      'session on every tool call, so start_work, update_work, finish_work attribute your work ' +
      'and keep your presence live without you passing an id.',
    'You can receive live messages from other agents in this workspace; they arrive on their own ' +
      'as relayed context, so you never need to poll for them.',
  ];
  if (others.length === 0) {
    lines.push('No other agents are currently registered.');
  } else {
    lines.push('Who else is here:');
    for (const entry of others) {
      lines.push(
        `  - ${entry.agentId} [${entry.liveness}/${entry.status}]: ${entry.summary ?? '-'}`,
      );
    }
  }
  return { agentId, message: lines.join('\n') };
}

/** Read piped stdin to a string. Returns '' when attached to a TTY (no input). */
function readStdin(): string {
  if (process.stdin.isTTY) {
    return '';
  }
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function registerHookCommand(program: Command): void {
  program
    .command('hook <event>')
    .description(
      'Run a Concord hook. events: pre-tool-use (PreToolUse overlap gate) and ' +
        'session-start (SessionStart presence auto-register); both read a Claude Code JSON ' +
        'payload on stdin.',
    )
    .action((event) => {
      if (event === 'session-start') {
        const result = handleSessionStart(openContext(process.cwd()).repos, readStdin());
        process.stdout.write(`${result.message}\n`);
        return;
      }
      if (event !== 'pre-tool-use') {
        process.stderr.write(`Unknown hook event: ${event}\n`);
        process.exitCode = 1;
        return;
      }
      const decision = decidePreToolUse(
        openContext(process.cwd()).repos,
        readStdin(),
        process.env['CONCORD_TASK'],
      );
      if (decision.message !== '') {
        process.stderr.write(`${decision.message}\n`);
      }
      if (decision.block) {
        // Claude Code treats PreToolUse exit code 2 as "deny the tool call".
        process.exitCode = 2;
      }
    });
}
