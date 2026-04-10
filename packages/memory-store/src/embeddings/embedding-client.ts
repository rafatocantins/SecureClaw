/**
 * embedding-client.ts — HTTP client for LLM embedding endpoints.
 *
 * Supports OpenAI-compatible APIs (OpenAI, Azure OpenAI, Ollama).
 *
 * Config (all via env vars):
 *   TESSERA_EMBEDDING_MODEL   — model name (e.g. "text-embedding-3-small", "nomic-embed-text")
 *   TESSERA_EMBEDDING_DIM     — expected output dimension (default 1536); used for validation
 *   TESSERA_EMBEDDING_BASE_URL — base URL (default https://api.openai.com/v1)
 *   OPENAI_API_KEY             — required for OpenAI endpoint; omit for Ollama
 *
 * If TESSERA_EMBEDDING_MODEL is not set, embed() returns null immediately
 * (graceful degradation to FTS5-only retrieval).
 *
 * Never throws — always resolves. Errors are logged to stderr and return null.
 */

export interface EmbeddingClientConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
  dim: number;
}

/**
 * Read embedding configuration from environment variables.
 * Returns null if TESSERA_EMBEDDING_MODEL is not set (disabled state).
 */
export function readEmbeddingConfig(): EmbeddingClientConfig | null {
  const model = process.env["TESSERA_EMBEDDING_MODEL"];
  if (!model) return null;

  return {
    model,
    baseUrl:
      process.env["TESSERA_EMBEDDING_BASE_URL"] ?? "https://api.openai.com/v1",
    apiKey: process.env["OPENAI_API_KEY"] ?? "",
    dim: parseInt(process.env["TESSERA_EMBEDDING_DIM"] ?? "1536", 10) || 1536,
  };
}

export class EmbeddingClient {
  private readonly config: EmbeddingClientConfig;

  constructor(config: EmbeddingClientConfig) {
    this.config = config;
  }

  get modelId(): string {
    return this.config.model;
  }

  get dim(): number {
    return this.config.dim;
  }

  /**
   * Generate an embedding vector for the given text.
   * Returns null if the API call fails (never throws).
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!text.trim()) return null;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(
        `${this.config.baseUrl}/embeddings`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.config.model,
            input: text.slice(0, 8192), // cap at 8K chars to avoid token limit errors
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!response.ok) {
        process.stderr.write(
          `[embedding-client] API error ${response.status} for model ${this.config.model}\n`
        );
        return null;
      }

      const body = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };

      const embedding = body.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        process.stderr.write(
          `[embedding-client] Unexpected response shape from ${this.config.baseUrl}\n`
        );
        return null;
      }

      return new Float32Array(embedding);
    } catch (err) {
      process.stderr.write(
        `[embedding-client] Embed failed: ${String(err)}\n`
      );
      return null;
    }
  }
}
