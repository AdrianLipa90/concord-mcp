import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/index.js';
import { relayAddress } from '../../src/relay/address.js';
import { CodexAppServerAdapter } from '../../src/relay/adapters.js';
import { startAgentRelay, type AgentSessionDelivery } from '../../src/relay/server.js';
import { SocketAgentMessageDispatcher } from '../../src/relay/socket-dispatcher.js';
import { registerPullEndpoint } from '../../src/cli/commands/inbox.js';
import { handleSendAgentMessageWithDelivery } from '../../src/tools/agent-messages.js';

function register(repos: Repositories, agentId: string): void {
  repos.agents.upsert({
    agentId,
    kind: agentId.split(':')[0] ?? 'agent',
    owner: null,
    model: null,
    pid: null,
    cwd: null,
    worktree: null,
    branch: null,
    summary: null,
    status: 'active',
  });
}

describe('local IPC relay', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createRepositories(openDatabase(':memory:'));
    register(repos, 'codex:sender');
    register(repos, 'codex:target');
  });

  it('injects an idle recipient and records the provider receipt', async () => {
    const deliveries: AgentSessionDelivery[] = [];
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('not busy')),
        inject: (delivery) => {
          deliveries.push(delivery);
          return Promise.resolve('turn-new');
        },
      },
    });
    try {
      const result = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: 'Start reviewing now.',
          idempotencyKey: 'inject-1',
        },
        new SocketAgentMessageDispatcher(),
      );

      expect(result.delivery).toBe('delivered');
      expect(result.immediateMode).toBe('inject');
      expect(result.message.providerReceipt).toBe('turn-new');
      expect(deliveries[0]?.content).toBe('Start reviewing now.');
    } finally {
      await relay.close();
    }
  });

  it('uses Codex expectedTurnId when steering an active turn', async () => {
    const requests: { method: string; params: Record<string, unknown> }[] = [];
    const adapter = new CodexAppServerAdapter(
      {
        request(method, params) {
          requests.push({ method, params });
          return Promise.resolve({});
        },
      },
      'thread-1',
      () => 'turn-7',
    );

    await adapter.steer({
      version: 1,
      type: 'deliver',
      messageId: 'm1',
      senderAgentId: 'a',
      recipientAgentId: 'b',
      content: 'Use the new constraint.',
    });

    expect(requests).toEqual([
      {
        method: 'turn/steer',
        params: {
          threadId: 'thread-1',
          expectedTurnId: 'turn-7',
          input: [{ type: 'text', text: 'Use the new constraint.' }],
        },
      },
    ]);
  });

  it('keeps push routing when a lifecycle hook refreshes the pull fallback', async () => {
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.resolve('steered'),
        inject: () => Promise.resolve('injected'),
      },
      pullFallback: true,
    });
    try {
      registerPullEndpoint(repos, 'codex:target', 'codex');
      expect(repos.agentEndpoints.getByAgent('codex:target')).toMatchObject({
        transport: 'local-ipc',
      });
      expect(repos.agentEndpoints.getByAgent('codex:target')?.capabilities).toContain('pull');
    } finally {
      await relay.close();
    }
  });

  it('keeps a message queued when immediate delivery fails but pull is available', async () => {
    const relay = await startAgentRelay({
      repos,
      agentId: 'codex:target',
      address: relayAddress(mkdtempSync(join(tmpdir(), 'concord-relay-')), 'codex:target'),
      adapter: {
        provider: 'codex',
        isBusy: () => false,
        steer: () => Promise.reject(new Error('offline')),
        inject: () => Promise.reject(new Error('offline')),
      },
      pullFallback: true,
    });
    try {
      const result = await handleSendAgentMessageWithDelivery(
        repos,
        {
          operation: 'prompt',
          agentId: 'codex:sender',
          toAgentId: 'codex:target',
          content: 'Retry through the inbox.',
          idempotencyKey: 'fallback-1',
        },
        new SocketAgentMessageDispatcher(),
      );
      expect(result.delivery).toBe('queued_pull');
      expect(result.message.status).toBe('pending');
      expect(result.outlook).toMatch(/remains queued/i);
    } finally {
      await relay.close();
    }
  });
});
