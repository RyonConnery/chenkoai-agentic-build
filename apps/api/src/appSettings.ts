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
  activeStorageMode: string;
  activeDataStore: string;
  activeAgentRunStore: string;
  activePromptRegistryStore: string;
  activeToolPermissionStore: string;
  databaseUrl: string;
  hasDatabaseUrl: boolean;
  storageDegradedReason?: string;
};

export type WorkspaceSettingsResponse = {
  configPath: string;
  configuredWorkspaceRoot: string;
  activeWorkspaceRoot: string;
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

export type WorkspaceSettingsMutation = {
  workspaceRoot?: string;
};

export async function loadLocalSettingsIntoEnv(): Promise<void> {
  Object.assign(process.env, await readFileSettings());
}

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
    localModel: config.LOCAL_LLM_MODEL ?? "llama3.2:3b",
    localEmbeddingModel: config.LOCAL_EMBEDDING_MODEL ?? "nomic-embed-text",
    hasOpenAiApiKey: Boolean(config.OPENAI_API_KEY),
  };
}

export function readStorageSettings(): StorageSettingsResponse {
  const config = readRuntimeSettings();
  const dataStore = config.CONFIGURED_DATA_STORE ?? config.DATA_STORE ?? "memory";
  const agentRunStore = config.CONFIGURED_AGENT_RUN_STORE ?? config.AGENT_RUN_STORE ?? "memory";
  const promptRegistryStore =
    config.CONFIGURED_PROMPT_REGISTRY_STORE ?? config.PROMPT_REGISTRY_STORE ?? "memory";
  const toolPermissionStore =
    config.CONFIGURED_TOOL_PERMISSION_STORE ?? config.TOOL_PERMISSION_STORE ?? "memory";
  const storageMode =
    dataStore === "postgres" &&
    agentRunStore === "postgres" &&
    promptRegistryStore === "postgres" &&
    toolPermissionStore === "postgres"
      ? "postgres"
      : "memory";
  const activeDataStore = config.DATA_STORE ?? "memory";
  const activeAgentRunStore = config.AGENT_RUN_STORE ?? "memory";
  const activePromptRegistryStore = config.PROMPT_REGISTRY_STORE ?? "memory";
  const activeToolPermissionStore = config.TOOL_PERMISSION_STORE ?? "memory";
  const activeStorageMode =
    activeDataStore === "postgres" &&
    activeAgentRunStore === "postgres" &&
    activePromptRegistryStore === "postgres" &&
    activeToolPermissionStore === "postgres"
      ? "postgres"
      : "memory";

  return {
    configPath: settingsPath(),
    storageMode,
    dataStore,
    agentRunStore,
    promptRegistryStore,
    toolPermissionStore,
    activeStorageMode,
    activeDataStore,
    activeAgentRunStore,
    activePromptRegistryStore,
    activeToolPermissionStore,
    databaseUrl:
      config.DATABASE_URL ??
      "postgresql://chenkoai:chenkoai_dev_password@localhost:5432/chenkoai",
    hasDatabaseUrl: Boolean(config.DATABASE_URL),
    storageDegradedReason: config.STORAGE_DEGRADED_REASON,
  };
}

export function readWorkspaceSettings(): WorkspaceSettingsResponse {
  const config = readRuntimeSettings();
  const fallback = process.cwd();

  return {
    configPath: settingsPath(),
    configuredWorkspaceRoot: config.CHENKOAI_WORKSPACE_ROOT ?? fallback,
    activeWorkspaceRoot: process.env.CHENKOAI_ACTIVE_WORKSPACE_ROOT ?? config.CHENKOAI_WORKSPACE_ROOT ?? fallback,
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
    LOCAL_LLM_MODEL: readString(input.localModel, "llama3.2:3b"),
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

export async function saveWorkspaceSettings(
  input: WorkspaceSettingsMutation,
): Promise<WorkspaceSettingsResponse> {
  const existing = await readFileSettings();
  const workspaceRoot = await readWorkspaceRoot(input.workspaceRoot);
  const next: Record<string, string> = {
    ...existing,
    CHENKOAI_WORKSPACE_ROOT: workspaceRoot,
  };

  await fs.writeFile(settingsPath(), serializeEnv(next), "utf8");
  Object.assign(process.env, next);
  process.env.CHENKOAI_ACTIVE_WORKSPACE_ROOT = workspaceRoot;
  return readWorkspaceSettings();
}

function readRuntimeSettings(): Record<string, string | undefined> {
  return {
    CHENKOAI_WORKSPACE_ROOT: process.env.CHENKOAI_WORKSPACE_ROOT,
    DATA_STORE: process.env.DATA_STORE,
    CONFIGURED_DATA_STORE: process.env.CHENKOAI_CONFIGURED_DATA_STORE,
    AGENT_RUN_STORE: process.env.AGENT_RUN_STORE,
    CONFIGURED_AGENT_RUN_STORE: process.env.CHENKOAI_CONFIGURED_AGENT_RUN_STORE,
    PROMPT_REGISTRY_STORE: process.env.PROMPT_REGISTRY_STORE,
    CONFIGURED_PROMPT_REGISTRY_STORE: process.env.CHENKOAI_CONFIGURED_PROMPT_REGISTRY_STORE,
    TOOL_PERMISSION_STORE: process.env.TOOL_PERMISSION_STORE,
    CONFIGURED_TOOL_PERMISSION_STORE: process.env.CHENKOAI_CONFIGURED_TOOL_PERMISSION_STORE,
    STORAGE_DEGRADED_REASON: process.env.CHENKOAI_STORAGE_DEGRADED_REASON,
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

async function readWorkspaceRoot(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workspace folder is required");
  }

  const candidate = value.trim().replace(/\//g, "\\");
  if (!path.win32.isAbsolute(candidate) && !path.posix.isAbsolute(candidate)) {
    throw new Error("Workspace folder must be a full absolute path, for example F:\\ChenkoAI\\Project");
  }

  const normalized = path.normalize(candidate);
  const stat = await fs.stat(normalized).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Workspace folder does not exist");
    }

    throw error;
  });

  if (!stat.isDirectory()) {
    throw new Error("Workspace path must be a folder");
  }

  return normalized;
}
