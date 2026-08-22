import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A short deterministic endpoint avoids Unix socket path-length limits. */
export function relayAddress(concordPath: string, agentId: string): string {
  const slug = createHash('sha256').update(`${concordPath}\0${agentId}`).digest('hex').slice(0, 24);
  if (process.platform === 'win32') return `\\\\.\\pipe\\concord-${slug}`;
  // macOS limits Unix-domain socket paths to roughly 104 bytes; repository
  // paths routinely exceed that. Hashing the workspace into a user-owned
  // runtime directory keeps the address short without losing isolation.
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  const directory = join(tmpdir(), `concord-relay-${user}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return join(directory, `${slug}.sock`);
}
