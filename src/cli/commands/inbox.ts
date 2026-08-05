import { randomBytes, randomUUID } from 'node:crypto';

import type { Command } from '@commander-js/extra-typings';

import type { Repositories } from '../../db/index.js';
import {
  renderHookPayload,
  renderMonitorLines,
  type DeliverableMessage,
} from '../../domain/pull-inbox.js';
import { PULL_CAPABILITIES, PULL_TRANSPORT } from '../../tools/agent-messages.js';
import { openContext } from '../context.js';

/** How long a registered pull endpoint stays promptable between drains. */
export const PULL_ENDPOINT_TTL_MS = 90_000;

/**
 * Advertise that `agentId` can receive messages by draining them from inside
 * its own session. Re-registering refreshes the lease, so a session that dies
 * stops looking promptable instead of silently swallowing messages.
 */
export function registerPullEndpoint(
  repos: Repositories,
  agentId: string,
  provider: string,
  now = Date.now(),
): void {
  // The endpoint references an agent row. Hook execution order is not
  // guaranteed, so do not assume the presence hook has already run — otherwise
  // whether messaging works depends on which SessionStart hook fired first.
  if (repos.agents.get(agentId) === undefined) {
    repos.agents.upsert({
      agentId,
      kind: provider,
      owner: null,
      model: null,
      pid: null,
      cwd: process.cwd(),
      worktree: null,
      branch: null,
      summary: null,
      status: 'active',
    });
  }
  const existing = repos.agentEndpoints.getByAgent(agentId);
  repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider,
    transport: PULL_TRANSPORT,
    capabilities: [...PULL_CAPABILITIES],
    address: `${PULL_TRANSPORT}:${agentId}`,
    credentialHash: existing?.credentialHash ?? randomBytes(32).toString('hex'),
    status: 'connected',
    expiresAt: new Date(now + PULL_ENDPOINT_TTL_MS).toISOString(),
  });
}

function toDeliverable(message: {
  messageId: string;
  senderAgentId: string;
  taskId: string | null;
  content: string;
}): DeliverableMessage {
  return {
    messageId: message.messageId,
    senderAgentId: message.senderAgentId,
    taskId: message.taskId,
    content: message.content,
  };
}

/**
 * Take every pending message for `agentId` and mark it delivered. Draining is
 * what records delivery, so a message is only ever counted as delivered once
 * the recipient has actually been handed it.
 */
export function drainInbox(
  repos: Repositories,
  agentId: string,
  provider: string,
): DeliverableMessage[] {
  registerPullEndpoint(repos, agentId, provider);
  const pending = repos.agentMessages.listPendingForRecipient(agentId);
  const drained: DeliverableMessage[] = [];
  for (const message of pending) {
    repos.agentMessages.markDelivered(message.messageId, provider, null);
    drained.push(toDeliverable(message));
  }
  repos.agents.touch(agentId);
  return drained;
}

function resolveAgentId(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  const agentId = explicit ?? env['CONCORD_AGENT_ID'];
  if (agentId === undefined || agentId.trim() === '') {
    throw new Error('Pass --agent <id> or set CONCORD_AGENT_ID.');
  }
  return agentId;
}

export function registerInboxCommand(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Receive live messages other agents addressed to this session');

  inbox
    .command('register')
    .description('Advertise this session as able to receive messages by draining them')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .action((options) => {
      const context = openContext(process.cwd());
      const agentId = resolveAgentId(options.agent, process.env);
      registerPullEndpoint(context.repos, agentId, options.provider);
      process.stdout.write(`Concord: ${agentId} can now receive live messages.\n`);
    });

  inbox
    .command('drain')
    .description('Print and acknowledge every message waiting for this agent')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option(
      '--format <format>',
      'post-tool-use and stop emit Claude Code hook JSON; monitor emits one line per message; json emits raw records',
      'json',
    )
    .action((options) => {
      const context = openContext(process.cwd());
      const agentId = resolveAgentId(options.agent, process.env);
      const messages = drainInbox(context.repos, agentId, options.provider);
      // Silence matters: a hook that prints on an empty inbox would inject
      // noise into the session on every single tool call.
      if (messages.length === 0) return;
      if (options.format === 'json') {
        process.stdout.write(`${JSON.stringify(messages)}\n`);
        return;
      }
      if (options.format === 'monitor') {
        for (const line of renderMonitorLines(messages)) process.stdout.write(`${line}\n`);
        return;
      }
      if (options.format === 'post-tool-use' || options.format === 'stop') {
        process.stdout.write(renderHookPayload(options.format, messages));
        return;
      }
      throw new Error(`Unknown --format: ${options.format}`);
    });
}
