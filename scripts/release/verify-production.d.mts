export interface McpReleaseContract {
  version: string;
  attestation: {
    calculatorIds: readonly string[];
  };
  newCalculatorIds: readonly string[];
}

export function verifyMcpSurface(
  baseUrl: string | URL,
  release: McpReleaseContract,
  options?: { signal?: AbortSignal },
): Promise<void>;

export function verifyLegacyMcpSurface(
  baseUrl: string | URL,
  clientVersion: string,
): Promise<void>;

export function loadRelease(): Promise<McpReleaseContract>;

export function verifyOnce(
  baseUrl: string | URL,
  release: McpReleaseContract,
  options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<void>;

export function verifyProduction(options?: {
  baseUrl?: string | URL;
  timeoutMs?: number;
  loadReleaseImpl?: () => Promise<McpReleaseContract>;
  verifyOnceImpl?: (
    baseUrl: string | URL,
    release: McpReleaseContract,
    options?: { signal?: AbortSignal },
  ) => Promise<void>;
  log?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<McpReleaseContract>;

export function verifyRollbackProduction(options: {
  baseUrl?: string | URL;
  expectedVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  verifyLegacyImpl?: (baseUrl: string | URL, clientVersion: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<void>;
