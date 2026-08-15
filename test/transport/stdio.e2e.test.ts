import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  jsonRpcResult,
  modernJsonRpcRequest,
} from '../support/protocol-fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

interface ClosedChild {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface TrackedChild {
  child: ReturnType<typeof spawn>;
  closed: Promise<ClosedChild>;
}

interface RawStdioConnection {
  stdoutLines: string[];
  stderr(): string;
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown> | string): void;
  end(): Promise<ClosedChild>;
}

const children: TrackedChild[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, closed }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }));
});

function spawnRawStdio(): RawStdioConnection {
  const child = spawn(process.execPath, ['dist/server/stdio.js'], {
    cwd: ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<ClosedChild>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.push({ child, closed });

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
      failPending(new Error(
        `stdio server exited before completing pending requests (code=${String(code)}, signal=${String(signal)}).`,
      ));
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
        if (waiter === undefined) {
          failPending(new Error(`stdio server emitted an unexpected response ID: ${message.id}.`));
        } else {
          waiters.delete(message.id);
          waiter.resolve(message);
        }
      } else if (message.id !== null && typeof message.method !== 'string') {
        failPending(new Error('stdio server emitted JSON-RPC without an ID or method.'));
      }
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const send = (message: Record<string, unknown> | string) => {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    child.stdin.write(`${line}\n`, (error) => {
      if (error) failPending(error);
    });
  };
  const request = (message: Record<string, unknown>) => new Promise<Record<string, unknown>>(
    (resolve, reject) => {
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
      send(message);
    },
  );

  return {
    stdoutLines,
    stderr: () => stderr,
    request,
    send,
    end: async () => {
      child.stdin.end();
      const exit = await closed;
      if (childFailure !== undefined) throw childFailure;
      return exit;
    },
  };
}

function expectJsonRpcOnly(lines: string[]): void {
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const line of lines) {
    expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
  }
}

function expectConservativeModernResult(result: Record<string, unknown>): void {
  expect(result.resultType).toBe('complete');
  expect(result.ttlMs).toBe(0);
  expect(result.cacheScope).toBe('private');
  expect(result._meta).toMatchObject({
    'io.modelcontextprotocol/serverInfo': {
      name: 'oath-mcp',
      version: expect.any(String),
    },
  });
}

describe('spawned stdio framing', () => {
  it('keeps the legacy opening exact and recovers after malformed input', async () => {
    const connection = spawnRawStdio();
    const initialized = await connection.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'raw-stdio-legacy', version: '0.0.0' },
      },
    });
    const initializeResult = jsonRpcResult(initialized);
    expect(initializeResult.protocolVersion).toBe(LEGACY_PROTOCOL_VERSION);
    connection.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    connection.send('{malformed-json');

    const listed = jsonRpcResult(await connection.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }));
    expect((listed.tools as { name: string }[]).map(({ name }) => name))
      .toContain('calculate_bmi');
    expect(listed).not.toHaveProperty('resultType');
    expect(listed).not.toHaveProperty('ttlMs');
    expect(listed).not.toHaveProperty('cacheScope');
    expect(listed).not.toHaveProperty('_meta');
    expect(listed).not.toHaveProperty('sessionId');

    await expect(connection.end()).resolves.toEqual({ code: 0, signal: null });
    expectJsonRpcOnly(connection.stdoutLines);
    expect(connection.stderr()).toBe('');
  }, 15_000);

  it('opens a separate modern process with discovery and wire-only metadata', async () => {
    const connection = spawnRawStdio();
    const discovered = jsonRpcResult(await connection.request(modernJsonRpcRequest(
      'server/discover',
      {},
      { id: 1, clientName: 'raw-stdio-modern' },
    )));
    expect(discovered.supportedVersions).toContain(MODERN_PROTOCOL_VERSION);
    expect(discovered.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expectConservativeModernResult(discovered);

    const firstList = jsonRpcResult(await connection.request(modernJsonRpcRequest(
      'tools/list',
      {},
      { id: 2, clientName: 'raw-stdio-modern' },
    )));
    const secondList = jsonRpcResult(await connection.request(modernJsonRpcRequest(
      'tools/list',
      {},
      { id: 3, clientName: 'raw-stdio-modern' },
    )));
    const names = (firstList.tools as { name: string }[]).map(({ name }) => name);
    expect(names).toEqual((secondList.tools as { name: string }[]).map(({ name }) => name));
    expect(names).toContain('calculate_bmi');
    expectConservativeModernResult(firstList);
    expect(firstList).not.toHaveProperty('sessionId');

    await expect(connection.end()).resolves.toEqual({ code: 0, signal: null });
    expectJsonRpcOnly(connection.stdoutLines);
    expect(connection.stderr()).toBe('');
  }, 15_000);
});
