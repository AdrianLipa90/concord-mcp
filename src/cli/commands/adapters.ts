import type { Command } from '@commander-js/extra-typings';

import { ensureAgentRegistered } from '../../tools/register-agent.js';
import { relayAddress } from '../../relay/address.js';
import { CodexAppServerAdapter } from '../../relay/adapters.js';
import { CodexDaemonClient } from '../../relay/codex-client.js';
import { startAgentRelay } from '../../relay/server.js';
import {
  installGlobalAdapters,
  renderAdapterReport,
  statusGlobalAdapters,
  uninstallGlobalAdapters,
} from '../../install/adapters/index.js';
import { openContext } from '../context.js';

async function hostCodex(agentId: string, threadId: string): Promise<void> {
  const context = openContext(process.cwd());
  ensureAgentRegistered(context.repos, { agentId, kind: 'codex' }, context.repoRoot);
  const client = new CodexDaemonClient();
  await client.connect();
  await client.resumeThread(threadId);
  const adapter = new CodexAppServerAdapter(client, threadId, () => client.currentTurnId());
  const relay = await startAgentRelay({
    repos: context.repos,
    agentId,
    address: relayAddress(context.concordPath, agentId),
    adapter,
    pullFallback: true,
  });
  const stop = (): void => {
    void relay.close().finally(() => {
      client.close();
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve) => {
    process.once('beforeExit', () => {
      resolve();
    });
  });
}

export function registerAdaptersCommand(program: Command): void {
  const adapters = program.command('adapters').description('Manage global harness adapters');
  adapters
    .command('install')
    .description('Install adapters into every detected harness')
    .option('--require', 'exit non-zero unless every detected adapter installs')
    .action((options) => {
      const report = installGlobalAdapters(import.meta.url, process.env);
      process.stdout.write(`${renderAdapterReport(report)}\n`);
      if (
        options.require === true &&
        report.some((entry) => entry.detected && entry.status !== 'installed')
      ) {
        process.exitCode = 1;
      }
    });
  adapters
    .command('status')
    .description('Show detection, installation, and delivery capability by harness')
    .action(() => {
      process.stdout.write(`${renderAdapterReport(statusGlobalAdapters(process.env))}\n`);
    });
  adapters
    .command('doctor')
    .description('Probe installed adapters and explain degraded delivery')
    .action(() => {
      process.stdout.write(`${renderAdapterReport(statusGlobalAdapters(process.env))}\n`);
    });
  adapters
    .command('uninstall')
    .description('Remove only globally installed Concord adapter artifacts')
    .action(() => {
      process.stdout.write(`${renderAdapterReport(uninstallGlobalAdapters(process.env))}\n`);
    });
  adapters
    .command('host-codex', { hidden: true })
    .requiredOption('--agent <id>')
    .requiredOption('--thread <id>')
    .action(async (options) => hostCodex(options.agent, options.thread));
}
