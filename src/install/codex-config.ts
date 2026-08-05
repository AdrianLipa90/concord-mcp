import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONCORD_SERVER_COMMAND } from './mcp-config.js';

/** The TOML table Codex reads Concord's server definition from. */
export const CODEX_SECTION_HEADER = '[mcp_servers.concord]';

/** Matches any TOML table header, which terminates the preceding table. */
const TABLE_HEADER = /^\s*\[/u;

/**
 * Absolute path to Codex's user-global config. Unlike everything else `install`
 * writes this lives outside the repo, so `CODEX_HOME` is honored — both because
 * Codex itself respects it and because it lets tests target a temp directory.
 */
export function codexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['CODEX_HOME'];
  const base = home !== undefined && home.trim() !== '' ? home : join(homedir(), '.codex');
  return join(base, 'config.toml');
}

/** Normalize preceding content so exactly one blank line precedes our table. */
function withTrailingBlankLine(lines: readonly string[]): string {
  if (lines.length === 0) {
    return '';
  }
  return `${lines.join('\n').replace(/\n*$/u, '')}\n\n`;
}

/**
 * Idempotently add Concord's `[mcp_servers.concord]` table to a Codex TOML
 * config. This splices the table by line range rather than parsing and
 * re-serializing, so unrelated tables — and the comments and formatting around
 * them, which a round-trip through a parser would discard — survive verbatim.
 */
export function upsertCodexMcpServer(existing: string | undefined): string {
  const section = `${CODEX_SECTION_HEADER}\ncommand = "${CONCORD_SERVER_COMMAND}"\n`;
  const source = existing ?? '';
  if (source.trim() === '') {
    return section;
  }

  const lines = source.split('\n');
  const found = lines.findIndex((line) => line.trim() === CODEX_SECTION_HEADER);
  const start = found === -1 ? lines.length : found;

  // Our table runs until the next table header; a nested `[mcp_servers.concord.env]`
  // is such a header, so any subtable the user added is preserved as trailing content.
  let end = lines.length;
  if (found !== -1) {
    for (let index = found + 1; index < lines.length; index += 1) {
      if (TABLE_HEADER.test(lines[index] ?? '')) {
        end = index;
        break;
      }
    }
  }

  const head = withTrailingBlankLine(lines.slice(0, start));
  const tail = lines.slice(end).join('\n');
  return tail === '' ? `${head}${section}` : `${head}${section}\n${tail}`;
}

const HOOKS_BEGIN = '# >>> concord hooks >>>';
const HOOKS_END = '# <<< concord hooks <<<';

/**
 * Codex passes its session id on stdin rather than in the environment, so every
 * hook reads the payload to work out which agent it is.
 */
const CONCORD_HOOKS_BLOCK = `${HOOKS_BEGIN}
# Delivers Concord messages from other agents into this session. Remove this
# block (markers included) to opt out.
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "concord inbox register --from-hook --provider codex"

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format post-tool-use"

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "concord inbox drain --from-hook --provider codex --format stop"
${HOOKS_END}`;

/**
 * Idempotently add Concord's lifecycle hooks to a Codex TOML config.
 *
 * The block is fenced by marker comments and appended at the end of the file.
 * Appending matters: TOML array-of-tables belong to whichever table header
 * precedes them, so splicing this into the middle would silently re-parent any
 * following keys.
 */
export function upsertCodexHooks(existing: string | undefined): string {
  const source = existing ?? '';
  const begin = source.indexOf(HOOKS_BEGIN);
  const end = source.indexOf(HOOKS_END);
  if (begin !== -1 && end > begin) {
    const head = source.slice(0, begin);
    const tail = source.slice(end + HOOKS_END.length);
    return `${head}${CONCORD_HOOKS_BLOCK}${tail}`;
  }
  const base = source.replace(/\n*$/u, '');
  return base === '' ? `${CONCORD_HOOKS_BLOCK}\n` : `${base}\n\n${CONCORD_HOOKS_BLOCK}\n`;
}

/**
 * Write Concord's hooks into Codex's user-global `config.toml`. Returns the
 * absolute path written.
 */
export function installCodexHooks(env: NodeJS.ProcessEnv = process.env): string {
  const fullPath = codexConfigFile(env);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertCodexHooks(existing));
  return fullPath;
}

/**
 * Register Concord in Codex's user-global `config.toml` (created if absent),
 * preserving the rest of the file. Returns the absolute path written, since it
 * lies outside the repo and callers surface that to the user.
 */
export function installCodexMcpConfig(env: NodeJS.ProcessEnv = process.env): string {
  const fullPath = codexConfigFile(env);
  const existing = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : undefined;
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, upsertCodexMcpServer(existing));
  return fullPath;
}
