/**
 * config.ts — Agent Runtime configuration.
 *
 * All process.env reads happen here, at startup. gRPC handlers receive
 * a resolved AgentRuntimeConfig and never touch process.env directly.
 *
 * PATT-002: Extract process.env from gRPC methods into config.ts.
 */

export interface AgentRuntimeConfig {
  /** gRPC bind address (default: "0.0.0.0:19001") */
  agentRuntimeAddr: string;

  /** Webhook alerting URL (optional — when set, alerting is enabled) */
  webhookUrl: string;

  /** Webhook HMAC secret (optional — enables X-Webhook-Signature header) */
  webhookSecret: string;

  /** Provider API keys, keyed by provider name (e.g. "anthropic" → "sk-ant-...") */
  providerApiKeys: Record<string, string | undefined>;

  /** Provider model overrides, keyed by provider name */
  providerModels: Record<string, string | undefined>;

  /** Provider base URL overrides, keyed by provider name */
  providerBaseUrls: Record<string, string | undefined>;
}

/**
 * Pre-loaded provider config (used by agent.impl.ts).
 * All values are resolved at startup — no lazy process.env reads.
 */
export interface ProviderSecrets {
  apiKey: string | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
}

const SUPPORTED_PROVIDERS = ["anthropic", "openai", "gemini", "ollama"] as const;

/**
 * Load all agent-runtime configuration from environment variables.
 *
 * Reads every env var once at startup. If a required variable is missing
 * the function throws immediately (fail-fast).
 *
 * Required vars: none at startup — the service supports multiple providers
 * and individual sessions may fail later if a provider key is absent.
 */
export function loadConfig(): AgentRuntimeConfig {
  const agentRuntimeAddr =
    process.env["AGENT_RUNTIME_ADDR"] ?? "0.0.0.0:19001";

  const webhookUrl = process.env["TESSERA_WEBHOOK_URL"] ?? "";
  const webhookSecret = process.env["TESSERA_WEBHOOK_SECRET"] ?? "";

  // Pre-load provider configs at startup so gRPC handlers never touch process.env.
  const providerApiKeys: Record<string, string | undefined> = {};
  const providerModels: Record<string, string | undefined> = {};
  const providerBaseUrls: Record<string, string | undefined> = {};

  for (const provider of SUPPORTED_PROVIDERS) {
    providerApiKeys[provider] =
      process.env[`${provider.toUpperCase()}_API_KEY`];
    providerModels[provider] =
      process.env[`${provider.toUpperCase()}_MODEL`];
  }

  // Ollama base URL (only provider with a custom base URL env var)
  providerBaseUrls["ollama"] =
    process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434";

  return {
    agentRuntimeAddr,
    webhookUrl,
    webhookSecret,
    providerApiKeys,
    providerModels,
    providerBaseUrls,
  };
}

/**
 * Extract provider secrets from the pre-loaded config for a given provider.
 *
 * Used by agent.impl.ts to read provider configuration without touching
 * process.env during request handling.
 */
export function getProviderSecrets(
  config: AgentRuntimeConfig,
  provider: string
): ProviderSecrets {
  return {
    apiKey: config.providerApiKeys[provider],
    model: config.providerModels[provider],
    baseUrl: config.providerBaseUrls[provider],
  };
}
