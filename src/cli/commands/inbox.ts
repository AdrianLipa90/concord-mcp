import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';

import { databasePath, resolveRepoRoot } from '../../config/paths.js';
import type { Repositories } from '../../db/index.js';
import { capabilityFor, encodeCapabilities } from '../../domain/delivery.js';
import {
  renderHookPayload,
  renderMonitorLines,
  type DeliverableMessage,
} from '../../domain/pull-inbox.js';
import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { resolveAgentId } from '../agent-identity.js';
import { openContext } from '../context.js';

/** How long a registered pull endpoint stays promptable between drains. */
const PULL_ENDPOINT_TTL_MS = 90_000;

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
  ensureAgentRegistered(repos, { agentId, kind: provider }, process.cwd());
  const capability = capabilityFor(provider);
  const existing = repos.agentEndpoints.getByAgent(agentId);
  repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider,
    transport: capability.transport,
    capabilities: encodeCapabilities(capability),
    address: `${capability.transport}:${agentId}`,
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
  const claimed = repos.agentMessages.claimPendingForRecipient(agentId, provider);
  repos.agents.touch(agentId);
  return claimed.map(toDeliverable);
}

/**
 * Whether this repository already uses Concord.
 *
 * The relay plugin is installed once and then loads in every session, including
 * repositories that have nothing to do with Concord. Opening a workspace
 * creates it, so these commands must check first and stay quiet otherwise —
 * merely having the plugin installed should never litter unrelated projects
 * with `.concord/` state.
 */
/**
 * Read a hook payload piped on stdin. Only ever called behind `--from-hook`:
 * a plugin monitor's stdin may stay open for the life of the session, and
 * blocking on it there would silently wedge message delivery.
 */
function readHookPayload(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return undefined;
  }
}

function workspaceExists(cwd: string): boolean {
  try {
    return existsSync(databasePath(resolveRepoRoot(cwd, process.env)));
  } catch {
    return false;
  }
}

export function registerInboxCommand(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Receive live messages other agents addressed to this session');

  inbox
    .command('status')
    .description('Exit 0 when this directory is a Concord workspace, 1 otherwise')
    .action(() => {
      // Lets the relay monitor bail out of a project that does not use Concord
      // instead of polling for the life of the session.
      if (!workspaceExists(process.cwd())) {
        process.exitCode = 1;
        return;
      }
      process.stdout.write('Concord workspace present.\n');
    });

  inbox
    .command('register')
    .description('Advertise this session as able to receive messages by draining them')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .action((options) => {
      if (!workspaceExists(process.cwd())) return;
      const context = openContext(process.cwd());
      const agentId = resolveAgentId(options.agent, process.env, {
        kind: options.provider,
        ...(options.fromHook === true ? { hookPayload: readHookPayload() ?? '' } : {}),
      });
      registerPullEndpoint(context.repos, agentId, options.provider);
      // Name the id. Clients whose session Concord can read resolve it on every
      // tool call; clients that scrub their environment (Codex) cannot, and for
      // those this line is the only place the agent learns who it is.
      process.stdout.write(
        `Concord: this session is agent \`${agentId}\` and can receive live messages from other ` +
          `agents. If a Concord tool asks for agent_id, use "${agentId}"; do not invent a ` +
          'different id.\n',
      );
    });

  inbox
    .command('drain')
    .description('Print and acknowledge every message waiting for this agent')
    .option('--agent <id>', 'Agent id; defaults to CONCORD_AGENT_ID, then to the current session')
    .option('--provider <name>', 'Client the agent runs in', 'claude-code')
    .option('--from-hook', 'Read the session id from a hook payload on stdin (Codex)')
    .option(
      '--format <format>',
      'post-tool-use and stop emit hook JSON; monitor emits one line per message; json emits raw records',
      'json',
    )
    .action((options) => {
      if (!workspaceExists(process.cwd())) return;
      const context = openContext(process.cwd());
      const agentId = resolveAgentId(options.agent, process.env, {
        kind: options.provider,
        ...(options.fromHook === true ? { hookPayload: readHookPayload() ?? '' } : {}),
      });
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
