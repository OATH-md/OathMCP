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
): Promise<void>;
