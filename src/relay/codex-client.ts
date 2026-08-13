import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { z } from 'zod';

import { VERSION } from '../version.js';

const responseSchema = z
  .object({
    id: z.number(),
    result: z.unknown().optional(),
    error: z.object({ message: z.string() }).loose().optional(),
  })
  .loose();
const notificationSchema = z
  .object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() })
  .loose();
const turnSchema = z.object({ id: z.string() }).loose();

function chunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return '';
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** JSONL client for the managed Codex app-server daemon's stdio proxy. */
export class CodexDaemonClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private activeTurnId: string | undefined;

  constructor(
    private readonly command = 'codex',
    private readonly args: readonly string[] = ['app-server', 'proxy'],
  ) {}

  currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  async connect(): Promise<void> {
    if (this.child !== undefined) return;
    const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.on('data', (chunk: unknown) => {
      this.onData(chunkText(chunk));
    });
    child.stderr.resume();
    child.once('error', (error) => {
      this.failAll(error);
    });
    child.once('exit', (code) => {
      this.failAll(new Error(`Codex app-server exited (${String(code)}).`));
    });
    await this.request('initialize', {
      clientInfo: { name: 'concord', title: 'Concord', version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request('thread/resume', { threadId });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (child === undefined) return Promise.reject(new Error('Codex app-server is not connected.'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const frame = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (frame !== '') this.onFrame(frame);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onFrame(frame: string): void {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      return;
    }
    const response = responseSchema.safeParse(value);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (pending === undefined) return;
      this.pending.delete(response.data.id);
      if (response.data.error !== undefined) pending.reject(new Error(response.data.error.message));
      else pending.resolve(response.data.result);
      return;
    }
    const notification = notificationSchema.safeParse(value);
    if (!notification.success) return;
    const turn = turnSchema.safeParse(notification.data.params?.['turn']);
    if (!turn.success) return;
    if (notification.data.method === 'turn/started') this.activeTurnId = turn.data.id;
    if (notification.data.method === 'turn/completed' && this.activeTurnId === turn.data.id) {
      this.activeTurnId = undefined;
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = undefined;
  }
}
