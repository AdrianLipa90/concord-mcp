import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { Command } from '@commander-js/extra-typings';

import { databasePath, resolveRepoRoot } from '../../config/paths.js';
import type { Repositories } from '../../db/index.js';
import {
  capabilityFor,
  encodeCapabilities,
  monitorCapabilityFor,
  type EndpointCapability,
} from '../../domain/delivery.js';
import { hookSessionId } from '../../domain/identity.js';
import {
  renderGeminiAfterAgent,
  renderGeminiAfterTool,
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
  capability: EndpointCapability = capabilityFor(provider),
): void {
  // The endpoint references an agent row. Hook execution order is not
  // guaranteed, so do not assume the presence hook has already run — otherwise
  // whether messaging works depends on which SessionStart hook fired first.
  ensureAgentRegistered(repos, { agentId, kind: provider }, process.cwd());
  const existing = repos.agentEndpoints.getByAgent(agentId);
  const preservePush = existing?.transport === 'local-ipc' && existing.status === 'connected';
  const capabilities = preservePush
    ? [...new Set([...existing.capabilities, ...encodeCapabilities(capability)])]
    : encodeCapabilities(capability);
  repos.agentEndpoints.upsert({
    endpointId: existing?.endpointId ?? randomUUID(),
    agentId,
    provider,
    transport: preservePush ? existing.transport : capability.transport,
    capabilities,
    address: preservePush ? existing.address : `${capability.transport}:${agentId}`,
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
  capability: EndpointCapability = capabilityFor(provider),
): DeliverableMessage[] {
  registerPullEndpoint(repos, agentId, provider, Date.now(), capability);
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

function launchCodexAdapterHost(repoRoot: string, agentId: string, threadId: string): void {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) return;
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      '--repo',
      repoRoot,
      'adapters',
      'host-codex',
      '--agent',
      agentId,
      '--thread',
      threadId,
    ],
    { cwd: repoRoot, env: process.env, detached: true, stdio: 'ignore' },
  );
  child.unref();
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
      const hookPayload = options.fromHook === true ? (readHookPayload() ?? '') : undefined;
      const agentId = resolveAgentId(options.agent, process.env, {
        kind: options.provider,
        ...(hookPayload === undefined ? {} : { hookPayload }),
      });
      const existing =
        options.provider === 'codex' ? context.repos.agentEndpoints.getByAgent(agentId) : undefined;
      registerPullEndpoint(context.repos, agentId, options.provider);
      const alreadyHosted =
        existing?.transport === 'local-ipc' &&
        existing.status === 'connected' &&
        (existing.expiresAt === null || Date.parse(existing.expiresAt) > Date.now());
      const threadId = hookPayload === undefined ? undefined : hookSessionId(hookPayload);
      if (options.provider === 'codex' && threadId !== undefined && !alreadyHosted) {
        launchCodexAdapterHost(context.repoRoot, agentId, threadId);
      }
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
      if (options.format === 'gemini-after-tool') {
        process.stdout.write(renderGeminiAfterTool(messages));
        return;
      }
      if (options.format === 'gemini-after-agent') {
        process.stdout.write(renderGeminiAfterAgent(messages));
        return;
      }
      if (options.format === 'post-tool-use' || options.format === 'stop') {
        process.stdout.write(renderHookPayload(options.format, messages));
        return;
      }
      throw new Error(`Unknown --format: ${options.format}`);
    });

  inbox
    .command('watch')
    .description('Wait for messages and emit one line per message for a harness monitor')
    .option('--agent <id>', 'Agent id; defaults to the current harness session')
    .option('--provider <name>', 'Client the agent runs in', 'grok')
    .option('--interval <ms>', 'Polling interval in milliseconds', '1000')
    .option('--once', 'Exit after emitting the first non-empty batch')
    .action(async (options) => {
      if (!workspaceExists(process.cwd())) return;
      const context = openContext(process.cwd());
      const agentId = resolveAgentId(options.agent, process.env, { kind: options.provider });
      const parsedInterval = Number.parseInt(options.interval, 10);
      if (!Number.isFinite(parsedInterval) || parsedInterval < 250) {
        throw new Error('--interval must be at least 250 milliseconds.');
      }
      const monitorCapability = monitorCapabilityFor(options.provider);
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const poll = (): void => {
          const messages = drainInbox(context.repos, agentId, options.provider, monitorCapability);
          for (const line of renderMonitorLines(messages)) process.stdout.write(`${line}\n`);
          if (options.once === true && messages.length > 0) {
            registerPullEndpoint(context.repos, agentId, options.provider);
            resolve();
            return;
          }
          timer = setTimeout(poll, parsedInterval);
        };
        const stopWatching = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          registerPullEndpoint(context.repos, agentId, options.provider);
          resolve();
        };
        process.once('SIGINT', stopWatching);
        process.once('SIGTERM', stopWatching);
        poll();
      });
    });
}
