export interface BundleSize {
  bytes: number;
  unit: string;
  value: number;
}

export interface WranglerDryRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function parseGzipSize(...outputs: string[]): BundleSize;
export function assertBelowFreeLimit(size: BundleSize): void;
export function checkWorkerBundle(options?: {
  log?: (message: string) => void;
  runWrangler?: () => Promise<WranglerDryRunResult>;
}): Promise<number>;
