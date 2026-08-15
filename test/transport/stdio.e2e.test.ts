import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const children: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

describe('spawned stdio framing', () => {
  it('keeps stdout JSON-RPC-only and recovers after a malformed input frame', async () => {
    const child = spawn(process.execPath, ['dist/server/stdio.js'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const stdoutLines: string[] = [];
    let stdoutBuffer = '';
    let stderr = '';
    const waiters = new Map<number, {
      resolve: (message: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }>();
    let childFailure: Error | undefined;
    const failPending = (error: Error) => {
      childFailure ??= error;
      for (const waiter of waiters.values()) waiter.reject(childFailure);
      waiters.clear();
    };
    child.once('error', failPending);
    child.once('exit', (code, signal) => {
      if (waiters.size > 0) {
        failPending(new Error(`stdio server exited before completing pending requests (code=${String(code)}, signal=${String(signal)}).`));
      }
    });
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes('\n')) {
        const newline = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        stdoutLines.push(line);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
          failPending(new Error(`stdio server emitted non-JSON output: ${String(error)}`));
          continue;
        }
        if (message.jsonrpc !== '2.0') {
          failPending(new Error('stdio server emitted JSON that is not a JSON-RPC 2.0 message.'));
          continue;
        }
        if (typeof message.id === 'number') {
          const waiter = waiters.get(message.id);
          if (waiter !== undefined) {
            waiters.delete(message.id);
            waiter.resolve(message);
          } else {
            failPending(new Error(`stdio server emitted an unexpected response ID: ${message.id}.`));
          }
        } else if (typeof message.method !== 'string') {
          failPending(new Error('stdio server emitted a JSON-RPC message without a numeric ID or method.'));
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const request = (message: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
      if (childFailure !== undefined) {
        reject(childFailure);
        return;
      }
      const id = message.id;
      if (typeof id !== 'number') {
        reject(new Error('stdio test requests require a numeric JSON-RPC ID.'));
        return;
      }
      waiters.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) failPending(error);
      });
    });
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'raw-stdio-test', version: '0.0.0' },
      },
    });
    expect(initialized).toHaveProperty('result');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write('{malformed-json\n');
    const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(listed).toHaveProperty('result');

    child.stdin.end();
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(childFailure).toBeUndefined();
    expect(stdoutLines.length).toBeGreaterThanOrEqual(2);
    for (const line of stdoutLines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(stderr).toBe('');
  }, 15_000);
});
