import { createHash } from "node:crypto";
import {
  type EmbeddingProvider,
  embeddingProviderSchema,
} from "@chenkoai/agent-core";

export type EmbeddingResponse = {
  provider: EmbeddingProvider;
  model: string;
  embedding: number[];
};

export interface EmbeddingProviderAdapter {
  readonly provider: EmbeddingProvider;
  embed(input: string): Promise<EmbeddingResponse>;
}

export function createEmbeddingProviderAdapter(): EmbeddingProviderAdapter {
  const provider = readProvider();

  if (provider === "openai-compatible") {
    return new OpenAiCompatibleEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      defaultModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    });
  }

  if (provider === "local-http") {
    return new LocalHttpEmbeddingProvider({
      baseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434",
      defaultModel: process.env.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text",
    });
  }

  return new MockEmbeddingProvider({
    dimensions: Number(process.env.MOCK_EMBEDDING_DIMENSIONS ?? 64),
  });
}

function readProvider(): EmbeddingProvider {
  return embeddingProviderSchema.parse(process.env.EMBEDDING_PROVIDER ?? "mock");
}

class MockEmbeddingProvider implements EmbeddingProviderAdapter {
  readonly provider = "mock" satisfies EmbeddingProvider;
  readonly #dimensions: number;

  constructor(config: { dimensions: number }) {
    this.#dimensions = Math.max(8, Math.min(1_536, config.dimensions));
  }

  async embed(input: string): Promise<EmbeddingResponse> {
    const embedding = new Array<number>(this.#dimensions).fill(0);
    const tokens = input.toLowerCase().match(/[a-z0-9]+/g) ?? [input.toLowerCase()];

    for (const token of tokens) {
      const hash = createHash("sha256").update(token).digest();
      const index = hash.readUInt32BE(0) % this.#dimensions;
      const sign = hash.readUInt32BE(4) % 2 === 0 ? 1 : -1;
      embedding[index] = (embedding[index] ?? 0) + sign;
    }

    return {
      provider: this.provider,
      model: `chenkoai-mock-embedding-${this.#dimensions}`,
      embedding: normalize(embedding),
    };
  }
}

class OpenAiCompatibleEmbeddingProvider implements EmbeddingProviderAdapter {
  readonly provider = "openai-compatible" satisfies EmbeddingProvider;
  readonly #config: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
  };

  constructor(config: { apiKey?: string; baseUrl: string; defaultModel: string }) {
    this.#config = config;
  }

  async embed(input: string): Promise<EmbeddingResponse> {
    const apiKey = this.#config.apiKey;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai-compatible");
    }

    const response = await fetch(`${this.#config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#config.defaultModel,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding provider request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiEmbeddingResponse;
    const embedding = payload.data[0]?.embedding;
    if (!embedding) {
      throw new Error("Embedding provider returned no embedding");
    }

    return {
      provider: this.provider,
      model: payload.model ?? this.#config.defaultModel,
      embedding,
    };
  }
}

class LocalHttpEmbeddingProvider implements EmbeddingProviderAdapter {
  readonly provider = "local-http" satisfies EmbeddingProvider;
  readonly #config: {
    baseUrl: string;
    defaultModel: string;
  };

  constructor(config: { baseUrl: string; defaultModel: string }) {
    this.#config = config;
  }

  async embed(input: string): Promise<EmbeddingResponse> {
    const response = await fetch(`${this.#config.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.#config.defaultModel,
        prompt: input,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local embedding request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as LocalEmbeddingResponse;
    if (!payload.embedding) {
      throw new Error("Local embedding provider returned no embedding");
    }

    return {
      provider: this.provider,
      model: this.#config.defaultModel,
      embedding: payload.embedding,
    };
  }
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return values;
  }

  return values.map((value) => value / magnitude);
}

type OpenAiEmbeddingResponse = {
  model?: string;
  data: Array<{
    embedding?: number[];
  }>;
};

type LocalEmbeddingResponse = {
  embedding?: number[];
};
