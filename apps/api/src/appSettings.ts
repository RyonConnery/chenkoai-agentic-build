import { promises as fs } from "node:fs";
import path from "node:path";

const settingsFileName = ".env.chenkoai.local";

export type ModelSettingsResponse = {
  configPath: string;
  provider: string;
  embeddingProvider: string;
  openaiBaseUrl: string;
  openaiModel: string;
  openaiEmbeddingModel: string;
  localBaseUrl: string;
  localModel: string;
  localEmbeddingModel: string;
  hasOpenAiApiKey: boolean;
};

export type StorageSettingsResponse = {
  configPath: string;
  storageMode: string;
  dataStore: string;
  agentRunStore: string;
  promptRegistryStore: string;
  toolPermissionStore: string;
  databaseUrl: string;
  hasDatabaseUrl: boolean;
};

export type ModelSettingsMutation = {
  provider?: string;
  embeddingProvider?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiEmbeddingModel?: string;
  localBaseUrl?: string;
  localModel?: string;
  localEmbeddingModel?: string;
  openaiApiKey?: string;
};

export type StorageSettingsMutation = {
  storageMode?: string;
  databaseUrl?: string;
};

export function readModelSettings(): ModelSettingsResponse {
  const config = readRuntimeSettings();

  return {
    configPath: settingsPath(),
    provider: config.MODEL_PROVIDER ?? "mock",
    embeddingProvider: config.EMBEDDING_PROVIDER ?? "mock",
    openaiBaseUrl: config.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiModel: config.OPENAI_MODEL ?? "gpt-4.1-mini",
    openaiEmbeddingModel: config.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    localBaseUrl: config.LOCAL_LLM_BASE_URL ?? "http://localhost:11434",
    localModel: config.LOCAL_LLM_MODEL ?? "llama3.1",
    localEmbeddingModel: config.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text",
    hasOpenAiApiKey: Boolean(config.OPENAI_API_KEY),
  };
}

export function readStorageSettings(): StorageSettingsResponse {
  const config = readRuntimeSettings();
  const dataStore = config.DATA_STORE ?? "memory";
  const agentRunStore = config.AGENT_RUN_STORE ?? "memory";
  const promptRegistryStore = config.PROMPT_REGISTRY_STORE ?? "memory";
  const toolPermissionStore = config.TOOL_PERMISSION_STORE ?? "memory";
  const storageMode =
    dataStore === "postgres" &&
    agentRunStore === "postgres" &&
    promptRegistryStore === "postgres" &&
    toolPermissionStore === "postgres"
      ? "postgres"
      : "memory";

  return {
    configPath: settingsPath(),
    storageMode,
    dataStore,
    agentRunStore,
    promptRegistryStore,
    toolPermissionStore,
    databaseUrl:
      config.DATABASE_URL ??
      "postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai",
    hasDatabaseUrl: Boolean(config.DATABASE_URL),
  };
}

export async function saveModelSettings(input: ModelSettingsMutation): Promise<ModelSettingsResponse> {
  const existing = await readFileSettings();
  const next: Record<string, string> = {
    ...existing,
    MODEL_PROVIDER: readChoice(input.provider, ["mock", "openai-compatible", "local-http"], "mock"),
    EMBEDDING_PROVIDER: readChoice(
      input.embeddingProvider,
      ["mock", "openai-compatible", "local-http"],
      "mock",
    ),
    OPENAI_BASE_URL: readString(input.openaiBaseUrl, "https://api.openai.com/v1"),
    OPENAI_MODEL: readString(input.openaiModel, "gpt-4.1-mini"),
    OPENAI_EMBEDDING_MODEL: readString(input.openaiEmbeddingModel, "text-embedding-3-small"),
    LOCAL_LLM_BASE_URL: readString(input.localBaseUrl, "http://localhost:11434"),
    LOCAL_LLM_MODEL: readString(input.localModel, "llama3.1"),
    LOCAL_EMBEDDING_MODEL: readString(input.localEmbeddingModel, "nomic-embed-text"),
  };

  if (typeof input.openaiApiKey === "string" && input.openaiApiKey.trim()) {
    next.OPENAI_API_KEY = input.openaiApiKey.trim();
  }

  await fs.writeFile(settingsPath(), serializeEnv(next), "utf8");
  Object.assign(process.env, next);
  return readModelSettings();
}

export async function saveStorageSettings(
  input: StorageSettingsMutation,
): Promise<StorageSettingsResponse> {
  const existing = await readFileSettings();
  const storageMode = readChoice(input.storageMode, ["memory", "postgres"], "memory");
  const next: Record<string, string> = {
    ...existing,
    DATA_STORE: storageMode,
    AGENT_RUN_STORE: storageMode,
    PROMPT_REGISTRY_STORE: storageMode,
    TOOL_PERMISSION_STORE: storageMode,
  };

  if (storageMode === "postgres") {
    next.DATABASE_URL = readString(
      input.databaseUrl,
      "postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai",
    );
  }

  await fs.writeFile(settingsPath(), serializeEnv(next), "utf8");
  Object.assign(process.env, next);
  return readStorageSettings();
}

function readRuntimeSettings(): Record<string, string | undefined> {
  return {
    DATA_STORE: process.env.DATA_STORE,
    AGENT_RUN_STORE: process.env.AGENT_RUN_STORE,
    PROMPT_REGISTRY_STORE: process.env.PROMPT_REGISTRY_STORE,
    TOOL_PERMISSION_STORE: process.env.TOOL_PERMISSION_STORE,
    DATABASE_URL: process.env.DATABASE_URL,
    MODEL_PROVIDER: process.env.MODEL_PROVIDER,
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL,
    LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
    LOCAL_LLM_MODEL: process.env.LOCAL_LLM_MODEL,
    LOCAL_EMBEDDING_MODEL: process.env.LOCAL_EMBEDDING_MODEL,
  };
}

async function readFileSettings(): Promise<Record<string, string>> {
  try {
    return parseEnv(await fs.readFile(settingsPath(), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function settingsPath(): string {
  return path.join(process.cwd(), settingsFileName);
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }

    result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }

  return result;
}

function serializeEnv(values: Record<string, string>): string {
  return `${Object.entries(values)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value.replace(/\r?\n/g, " ")}`)
    .join("\n")}\n`;
}

function readChoice(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
