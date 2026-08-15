export interface WranglerResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface ContinuityMonitor {
  ready: Promise<void>;
  failed: Promise<Error>;
  assertHealthy(): void;
  stop(options?: { assertHealthy?: boolean }): Promise<void>;
}

export function parseActiveVersion(
  value: unknown,
  label: string,
): string;

export function parseUploadedVersionId(...outputs: string[]): string;

export function parseDeployArgs(argv: string[]): {
  tag: string;
  sha: string;
  baseUrl: string;
};

export function runWranglerCommand(options: {
  args: string[];
  cwd: string;
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof import('node:child_process').spawn;
  stderr?: NodeJS.WritableStream;
  stdout?: NodeJS.WritableStream;
  timeoutMs?: number;
}): Promise<WranglerResult>;

export function createContinuityMonitor(options: {
  baseUrl?: string | URL;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  probe?: () => Promise<void>;
}): ContinuityMonitor;

export function readHealthVersion(
  baseUrl: string | URL,
  fetchImpl?: typeof fetch,
): Promise<string>;

export function deployProduction(
  options: {
    tag: string;
    sha: string;
    baseUrl?: string | URL;
    githubOutput?: string;
  },
  dependencies?: {
    runWrangler?: (options: {
      args: string[];
      cwd: string;
      quiet?: boolean;
    }) => Promise<WranglerResult>;
    fetchImpl?: typeof fetch;
    monitorFactory?: (options: {
      baseUrl: string | URL;
      fetchImpl: typeof fetch;
    }) => ContinuityMonitor;
    verifyProductionImpl?: (options: {
      baseUrl: string | URL;
      signal: AbortSignal;
      timeoutMs: number;
    }) => Promise<unknown>;
    verifyRollbackImpl?: (options: {
      baseUrl: string | URL;
      expectedVersion: string;
    }) => Promise<void>;
    writeOutputs?: (path: string | undefined, values: Record<string, string>) => Promise<void>;
    log?: (message: string) => void;
  },
): Promise<Record<string, string>>;
