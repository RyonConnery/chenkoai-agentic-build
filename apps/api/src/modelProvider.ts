import {
  normalizeModelGenerateRequest,
  type ModelGenerateRequest,
  type ModelGenerateResponse,
  type ModelProvider,
  type NormalizedModelGenerateRequest,
} from "@chenkoai/agent-core";

export interface ModelProviderAdapter {
  readonly provider: ModelProvider;
  generate(input: ModelGenerateRequest): Promise<ModelGenerateResponse>;
}

export function createModelProviderAdapter(): ModelProviderAdapter {
  const provider = readProvider();

  if (provider === "openai-compatible") {
    return new OpenAiCompatibleProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      defaultModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    });
  }

  if (provider === "local-http") {
    return new LocalHttpProvider({
      baseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:11434",
      defaultModel: process.env.LOCAL_LLM_MODEL ?? "llama3.2:3b",
    });
  }

  return new MockModelProvider();
}

function readProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER ?? "mock";

  if (provider === "openai-compatible" || provider === "local-http" || provider === "mock") {
    return provider;
  }

  throw new Error(`Unsupported MODEL_PROVIDER: ${provider}`);
}

class MockModelProvider implements ModelProviderAdapter {
  readonly provider = "mock" satisfies ModelProvider;

  async generate(input: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const request = normalizeModelGenerateRequest(input);
    const model = request.model ?? "chenkoai-mock-v1";
    const mockToolRequest = createMockToolRequest(request.prompt);

    return {
      provider: this.provider,
      model,
      text: [
        "Mock ChenkoAI model response.",
        `Prompt: ${request.prompt}`,
        request.systemPrompt ? `System: ${request.systemPrompt}` : undefined,
        mockToolRequest,
      ]
        .filter(Boolean)
        .join("\n"),
      finishReason: "stop",
      usage: estimateUsage(request),
    };
  }
}

function createMockToolRequest(prompt: string): string | undefined {
  const match = prompt.match(/MOCK_TOOL_WRITE:([^:\n]+):([^\n]+)/);
  if (!match) {
    return undefined;
  }

  return [
    "```chenkoai-tool",
    JSON.stringify({
      name: "workspace.write_text_file",
      input: {
        path: match[1]?.trim(),
        content: match[2]?.trim(),
      },
    }),
    "```",
  ].join("\n");
}

class OpenAiCompatibleProvider implements ModelProviderAdapter {
  readonly provider = "openai-compatible" satisfies ModelProvider;
  readonly #config: {
    apiKey?: string;
    baseUrl: string;
    defaultModel: string;
  };

  constructor(config: { apiKey?: string; baseUrl: string; defaultModel: string }) {
    this.#config = config;
  }

  async generate(input: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const request = normalizeModelGenerateRequest(input);
    const apiKey = this.#config.apiKey;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when MODEL_PROVIDER=openai-compatible");
    }

    const model = request.model ?? this.#config.defaultModel;
    const response = await fetch(`${this.#config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: toMessages(request),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      throw new Error(`Model provider request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiChatCompletionResponse;
    const choice = payload.choices[0];

    return {
      provider: this.provider,
      model: payload.model ?? model,
      text: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason,
      usage: payload.usage
        ? {
            inputTokens: payload.usage.prompt_tokens,
            outputTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          }
        : undefined,
    };
  }
}

class LocalHttpProvider implements ModelProviderAdapter {
  readonly provider = "local-http" satisfies ModelProvider;
  readonly #config: {
    baseUrl: string;
    defaultModel: string;
  };

  constructor(config: { baseUrl: string; defaultModel: string }) {
    this.#config = config;
  }

  async generate(input: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const request = normalizeModelGenerateRequest(input);
    const model = request.model ?? this.#config.defaultModel;
    const response = await fetch(`${this.#config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: [request.systemPrompt, request.prompt].filter(Boolean).join("\n\n"),
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxTokens,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as LocalGenerateResponse;

    return {
      provider: this.provider,
      model,
      text: payload.response ?? "",
      finishReason: payload.done ? "stop" : undefined,
      usage: {
        inputTokens: payload.prompt_eval_count,
        outputTokens: payload.eval_count,
        totalTokens:
          payload.prompt_eval_count !== undefined && payload.eval_count !== undefined
            ? payload.prompt_eval_count + payload.eval_count
            : undefined,
      },
    };
  }
}

function toMessages(request: NormalizedModelGenerateRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  messages.push({ role: "user", content: request.prompt });
  return messages;
}

function estimateUsage(request: NormalizedModelGenerateRequest): ModelGenerateResponse["usage"] {
  const input = [request.systemPrompt, request.prompt].filter(Boolean).join(" ");
  const inputTokens = Math.ceil(input.length / 4);
  const outputTokens = 12;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

type OpenAiMessage = {
  role: "system" | "user";
  content: string;
};

type OpenAiChatCompletionResponse = {
  model?: string;
  choices: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type LocalGenerateResponse = {
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};
