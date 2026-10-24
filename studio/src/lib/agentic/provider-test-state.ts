interface ConnectionConfig {
  model: string;
  baseUrl: string;
  apiKeyEnc: string;
  timeoutMs: number;
  maxRetries: number;
}

/** A test result belongs to the connection settings that were tested, not its label. */
export function connectionSettingsChanged(previous: ConnectionConfig, next: ConnectionConfig): boolean {
  return previous.model !== next.model || previous.baseUrl !== next.baseUrl ||
    previous.apiKeyEnc !== next.apiKeyEnc || previous.timeoutMs !== next.timeoutMs ||
    previous.maxRetries !== next.maxRetries;
}
