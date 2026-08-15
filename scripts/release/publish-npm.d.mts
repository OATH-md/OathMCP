export interface PublishOutputs {
  package_name: string;
  package_version: string;
  package_integrity: string;
  package_tarball: string;
}

export interface NpmCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface PublishedPackageVersion {
  name?: string;
  version?: string;
  gitHead?: string;
  dist?: { integrity?: string; tarball?: string };
}

export interface NpmPackument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PublishedPackageVersion>;
}

export function parsePublishArgs(argv: string[]): { sha: string; timeoutMs?: number };
export function runNpmCommand(options: Record<string, unknown>): Promise<NpmCommandResult>;
export function readRegistryPackage(options: {
  packageName: string;
  registry?: string;
  fetchImpl?: typeof fetch;
}): Promise<NpmPackument | undefined>;
export function parseLocalPackIntegrity(
  stdout: string,
  expected: { packageName: string; version: string },
): string;
export function readLocalPackageIntegrity(options: {
  packageName: string;
  version: string;
  projectRoot: string;
  runNpm: (options: {
    args: string[];
    cwd: string;
    streamOutput?: boolean;
  }) => Promise<NpmCommandResult>;
}): Promise<string>;
export function validatePublishedVersion(
  packument: NpmPackument | undefined,
  expected: { packageName: string; version: string; sha: string; integrity: string },
): { integrity: string; tarball: string } | { pendingLatest: true } | undefined;
export function publishNpm(
  options: {
    sha: string;
    timeoutMs?: number;
    githubOutput?: string;
    projectRoot?: string;
  },
  dependencies?: {
    fetchImpl?: typeof fetch;
    runNpm?: (options: {
      args: string[];
      cwd: string;
      streamOutput?: boolean;
    }) => Promise<NpmCommandResult>;
    sleep?: (milliseconds: number) => Promise<void>;
    writeOutputs?: (path: string | undefined, values: PublishOutputs) => Promise<void>;
    log?: (message: string) => void;
  },
): Promise<PublishOutputs>;
