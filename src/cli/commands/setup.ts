import type { Command } from '@commander-js/extra-typings';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeArtifacts } from '../../artifacts/index.js';
import { installClaudeHook } from '../../install/claude-hooks.js';
import { installCodexMcpConfig } from '../../install/codex-config.js';
import { installConcord } from '../../install/index.js';
import {
  installGlobalAdapters,
  renderAdapterReport,
  type AdapterReport,
} from '../../install/adapters/index.js';
import {
  McpConfigParseError,
  installMcpConfigs,
  removeGlobalCursorConcord,
} from '../../install/mcp-config.js';
import { openContext } from '../context.js';

const CONCORD_GITIGNORE_ENTRY = '.concord/';

export interface SetupOptions {
  claudeHooks?: boolean;
  mcp?: boolean;
  adapters?: boolean;
  requireAdapters?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface SetupResult {
  repoRoot: string;
  workspaceId: string;
  concordPath: string;
  written: string[];
  adapters: AdapterReport[];
}

/** Ensure Concord's generated workspace is ignored without changing other rules. */
export function ensureConcordIgnored(repoRoot: string): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const entries = current.split(/\r?\n/u).map((line) => line.trim());
  if (entries.includes(CONCORD_GITIGNORE_ENTRY)) {
    return;
  }

  const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${current}${separator}${CONCORD_GITIGNORE_ENTRY}\n`);
}

/** Set up one repository completely: state, instructions, and client registration. */
export function runSetup(cwd: string, options: SetupOptions = {}): SetupResult {
  const env = options.env ?? process.env;
  const ctx = openContext(cwd, env);

  ensureConcordIgnored(ctx.repoRoot);
  writeArtifacts(ctx.concordPath, ctx.repos);

  const written = installConcord(ctx.repoRoot);
  let adapters: AdapterReport[] = [];
  if (options.claudeHooks === true) {
    written.push(installClaudeHook(ctx.repoRoot));
  }
  if (options.mcp !== false) {
    written.push(...installMcpConfigs(ctx.repoRoot));
    const migratedCursorConfig = removeGlobalCursorConcord(env);
    if (migratedCursorConfig !== undefined) written.push(migratedCursorConfig);
    written.push(installCodexMcpConfig(env));
  }
  // `env` is also the unit-test/config-path seam. Avoid touching unrelated
  // real harness homes unless adapter installation was explicitly requested.
  const installAdapters = options.adapters ?? (options.mcp !== false && options.env === undefined);
  if (installAdapters) {
    adapters = installGlobalAdapters(import.meta.url, env);
    for (const adapter of adapters) {
      if (adapter.installedPath !== undefined) written.push(adapter.installedPath);
    }
    if (
      options.requireAdapters === true &&
      adapters.some((adapter) => adapter.detected && adapter.status !== 'installed')
    ) {
      const incomplete = adapters
        .filter((adapter) => adapter.detected && adapter.status !== 'installed')
        .map((adapter) => `${adapter.harness}:${adapter.status}`)
        .join(', ');
      throw new Error(`Required harness adapters are incomplete: ${incomplete}`);
    }
  }
  return {
    repoRoot: ctx.repoRoot,
    workspaceId: ctx.workspaceId,
    concordPath: ctx.concordPath,
    // A file touched by two installers is still one file to the reader.
    written: [...new Set(written)],
    adapters,
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Set up Concord state, instructions, and MCP clients for this repository')
    .option(
      '--claude-hooks',
      'also install an opt-in Claude Code PreToolUse overlap hook into .claude/settings.json',
    )
    .option('--no-mcp', 'skip MCP client registration; write local state and instructions only')
    .option('--no-adapters', 'skip global harness adapter installation')
    .option('--require-adapters', 'fail unless every detected harness adapter is ready')
    .action((options) => {
      try {
        const setupOptions: SetupOptions = {
          mcp: options.mcp,
          adapters: options.adapters,
          ...(options.requireAdapters === true ? { requireAdapters: true } : {}),
        };
        if (options.claudeHooks === true) {
          setupOptions.claudeHooks = true;
        }
        const result = runSetup(process.cwd(), setupOptions);
        process.stdout.write(
          `Concord setup complete\n` +
            `  repository: ${result.repoRoot}\n` +
            `  workspace:  ${result.workspaceId}\n` +
            `  state:      ${result.concordPath}\n` +
            `  configured:\n`,
        );
        for (const path of result.written) {
          process.stdout.write(`    ${path}\n`);
        }
        if (result.adapters.length > 0) {
          process.stdout.write(`\n${renderAdapterReport(result.adapters)}\n`);
        }
        if (options.claudeHooks === true) {
          process.stdout.write(
            'PreToolUse hook installed. Set CONCORD_TASK=<your task id> so it excludes your own claim.\n',
          );
        }
        if (options.mcp) {
          process.stdout.write(
            'Restart your coding client so it reloads the project MCP server.\n' +
              'Codex: run /hooks once and trust the Concord hooks. Until you do, Codex skips ' +
              'them silently and cannot receive messages from other agents.\n',
          );
        }
      } catch (error) {
        if (!(error instanceof McpConfigParseError)) {
          throw error;
        }
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
}
