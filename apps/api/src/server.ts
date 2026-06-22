import Fastify from "fastify";
import { Pool } from "pg";
import {
  type AgentAutoRunRequest,
  type AgentRunRequest,
  type DataSearchRequest,
  type EmbeddingRebuildRequest,
  type ModelGenerateRequest,
  type PromptTemplateMutationRequest,
  type TextIngestRequest,
  type ToolExecuteRequest,
  type ToolPermissionDecisionRequest,
  normalizeDataSearchRequest,
  normalizeEmbeddingRebuildRequest,
} from "@chenkoai/agent-core";
import { ZodError } from "zod";
import { AgentAutoRunner } from "./agentAutoRunner.js";
import { AgentMemoryRetriever } from "./agentMemory.js";
import { AgentPlanner } from "./agentPlanner.js";
import { AgentRunReporter } from "./agentRunReporter.js";
import { createAgentRunStore } from "./agentRunPersistence.js";
import { AgentRuntime } from "./agentRuntime.js";
import { AgentToolExecutor } from "./agentToolExecutor.js";
import {
  readModelSettings,
  readStorageSettings,
  loadLocalSettingsIntoEnv,
  saveModelSettings,
  saveStorageSettings,
  type ModelSettingsMutation,
  type StorageSettingsMutation,
} from "./appSettings.js";
import { createDataStore } from "./dataPersistence.js";
import {
  createEmbeddingProviderAdapter,
  type EmbeddingProviderAdapter,
} from "./embeddingProvider.js";
import { LocalToolRegistry } from "./localTools.js";
import {
  createModelProviderAdapter,
  type ModelProviderAdapter,
} from "./modelProvider.js";
import { createPromptRegistry } from "./promptRegistryPersistence.js";
import { SystemScanner } from "./systemScanner.js";
import { createToolPermissionStore } from "./toolPermissionPersistence.js";

const port = Number(process.env.CHENKOAI_API_PORT ?? 8787);
await loadLocalSettingsIntoEnv();
await fallBackToMemoryIfPostgresIsUnavailable();
const server = Fastify({ logger: true });
const agentRunStore = createAgentRunStore();
const dataStore = createDataStore();
const embeddingProvider = createDynamicEmbeddingProviderAdapter();
const toolPermissions = createToolPermissionStore();
const localTools = new LocalToolRegistry(toolPermissions);
const modelProvider = createDynamicModelProviderAdapter();
const promptRegistry = await createPromptRegistry();
const agentMemoryRetriever = new AgentMemoryRetriever(dataStore, embeddingProvider);
const agentToolExecutor = new AgentToolExecutor(agentRunStore, localTools);
const agentPlanner = new AgentPlanner(agentRunStore, modelProvider);
const agentRunReporter = new AgentRunReporter(agentRunStore, toolPermissions);
const systemScanner = new SystemScanner({
  dataStore,
  embeddingProvider,
  workspaceRoot: process.env.CHENKOAI_WORKSPACE_ROOT,
});
const agentRuntime = new AgentRuntime(
  agentRunStore,
  modelProvider,
  promptRegistry,
  agentMemoryRetriever,
  agentToolExecutor,
);
const agentAutoRunner = new AgentAutoRunner(agentRunStore, agentPlanner, agentRuntime);

server.addHook("onRequest", async (_request, reply) => {
  reply.header("Access-Control-Allow-Origin", process.env.CHENKOAI_DESKTOP_ORIGIN ?? "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
});

server.options("/*", async (_request, reply) => reply.code(204).send());

server.get("/health", async () => ({
  ok: true,
  service: "chenkoai-api",
  storageDegradedReason: process.env.CHENKOAI_STORAGE_DEGRADED_REASON,
}));

server.get("/model/provider", async () => ({
  provider: modelProvider.provider,
}));

server.get("/embeddings/provider", async () => ({
  provider: embeddingProvider.provider,
}));

server.get("/settings/model", async () => readModelSettings());

server.post<{ Body: ModelSettingsMutation }>("/settings/model", async (request, reply) => {
  const settings = await saveModelSettings(request.body ?? {});
  return reply.code(201).send({
    ...settings,
    restartRequired: true,
  });
});

server.get("/settings/storage", async () => readStorageSettings());

server.post<{ Body: StorageSettingsMutation }>("/settings/storage", async (request, reply) => {
  const settings = await saveStorageSettings(request.body ?? {});
  return reply.code(201).send({
    ...settings,
    restartRequired: true,
  });
});

server.get("/system/profile", async () => systemScanner.profile());

server.post<{ Body: { maxFiles?: number; maxFileBytes?: number } }>(
  "/system/scan",
  async (request, reply) => {
    const result = await systemScanner.scan(request.body ?? {});
    return reply.code(201).send(result);
  },
);

server.post<{ Body: ModelGenerateRequest }>("/model/generate", async (request) => {
  return await modelProvider.generate(request.body);
});

server.get("/tools", async () => ({
  tools: localTools.list(),
}));

server.post<{ Body: ToolExecuteRequest }>("/tools/execute", async (request) => {
  return await localTools.execute(request.body);
});

server.get("/tools/permissions", async () => ({
  permissions: await toolPermissions.list(),
}));

server.post<{
  Body: ToolPermissionDecisionRequest;
  Params: { id: string };
}>("/tools/permissions/:id/decision", async (request, reply) => {
  const permission = await toolPermissions.decide(request.params.id, request.body);
  if (!permission) {
    return reply.code(404).send({ error: "tool_permission_not_found" });
  }

  return permission;
});

server.post<{ Body: TextIngestRequest }>("/data/ingest/text", async (request, reply) => {
  const result = await dataStore.ingestText(request.body);
  return reply.code(201).send(result);
});

server.get("/data/datasets", async () => ({
  datasets: await dataStore.listDatasets(),
}));

server.get<{ Querystring: { datasetId?: string } }>("/data/documents", async (request) => ({
  documents: await dataStore.listDocuments(request.query.datasetId),
}));

server.get<{ Params: { id: string } }>("/data/documents/:id", async (request, reply) => {
  const document = await dataStore.getDocument(request.params.id);
  if (!document) {
    return reply.code(404).send({ error: "data_document_not_found" });
  }

  return document;
});

server.get<{ Params: { id: string } }>("/data/documents/:id/chunks", async (request) => ({
  chunks: await dataStore.listChunks(request.params.id),
}));

server.post<{ Body: EmbeddingRebuildRequest }>(
  "/data/embeddings/rebuild",
  async (request) => {
    const rebuildRequest = normalizeEmbeddingRebuildRequest(request.body ?? {});
    const chunks = await dataStore.listChunksNeedingEmbedding(
      rebuildRequest.limit,
      rebuildRequest.datasetId,
    );
    let model = "";

    for (const chunk of chunks) {
      const response = await embeddingProvider.embed(chunk.content);
      model = response.model;
      await dataStore.saveChunkEmbedding(chunk.id, response.embedding, response.model);
    }

    return {
      provider: embeddingProvider.provider,
      model,
      embeddedChunks: chunks.length,
    };
  },
);

server.post<{ Body: DataSearchRequest }>("/data/search", async (request) => {
  const searchRequest = normalizeDataSearchRequest(request.body);
  const response = await embeddingProvider.embed(searchRequest.query);
  const results = await dataStore.searchChunks({
    embedding: response.embedding,
    embeddingModel: response.model,
    datasetId: searchRequest.datasetId,
    limit: searchRequest.limit,
  });

  return {
    provider: response.provider,
    model: response.model,
    results,
  };
});

server.post<{ Body: DataSearchRequest }>("/memory/answer", async (request) => {
  const searchRequest = normalizeDataSearchRequest(request.body);
  const finalLimit = searchRequest.limit;
  const embedding = await embeddingProvider.embed(searchRequest.query);
  const candidates = await dataStore.searchChunks({
    embedding: embedding.embedding,
    embeddingModel: embedding.model,
    datasetId: searchRequest.datasetId,
    limit: Math.min(50, Math.max(finalLimit * 5, 20)),
  });
  const results = rerankMemoryResults(candidates, finalLimit);
  const context = formatAnswerContext(results);
  const generated = await modelProvider.generate({
    systemPrompt: [
      "You are ChenkoAI's memory analyst.",
      "Answer using only the provided memory context.",
      "When you use a source, cite it with bracket numbers like [1].",
      "Give a direct, useful answer when the memory context contains project overview or capability details.",
      "Only say information is missing when the provided context truly lacks it.",
    ].join(" "),
    prompt: [
      `Question: ${searchRequest.query}`,
      "",
      "Memory context:",
      context || "No matching memory chunks were found.",
    ].join("\n"),
    temperature: 0.1,
    maxTokens: 768,
  });

  return {
    query: searchRequest.query,
    provider: generated.provider,
    model: generated.model,
    embeddingProvider: embedding.provider,
    embeddingModel: embedding.model,
    answer: generated.text,
    results,
  };
});

server.get("/prompts", async () => ({
  prompts: await promptRegistry.list(),
}));

server.get<{ Params: { id: string } }>("/prompts/:id", async (request, reply) => {
  const prompt = await promptRegistry.get(request.params.id);
  if (!prompt) {
    return reply.code(404).send({ error: "prompt_template_not_found" });
  }

  return prompt;
});

server.get<{ Params: { id: string } }>("/prompts/:id/versions", async (request) => ({
  versions: await promptRegistry.listVersions(request.params.id),
}));

server.put<{
  Body: PromptTemplateMutationRequest;
  Params: { id: string; version: string };
}>("/prompts/:id/versions/:version", async (request, reply) => {
  const version = await promptRegistry.upsertVersion(
    request.params.id,
    request.params.version,
    request.body,
  );

  return reply.code(201).send(version);
});

server.post<{ Params: { id: string; version: string } }>(
  "/prompts/:id/versions/:version/activate",
  async (request, reply) => {
    const version = await promptRegistry.activateVersion(
      request.params.id,
      request.params.version,
    );
    if (!version) {
      return reply.code(404).send({ error: "prompt_template_version_not_found" });
    }

    return version;
  },
);

server.post<{ Body: AgentRunRequest }>("/agent/run", async (request) => {
  return await agentRunStore.create(request.body);
});

server.post<{ Body: AgentRunRequest }>("/agent/runs", async (request, reply) => {
  const snapshot = await agentRunStore.create(request.body);
  return reply.code(201).send(snapshot);
});

server.get("/agent/runs", async () => ({
  runs: await agentRunStore.list(),
}));

server.get<{ Params: { id: string } }>("/agent/runs/:id", async (request, reply) => {
  const snapshot = await agentRunStore.getSnapshot(request.params.id);
  if (!snapshot) {
    return reply.code(404).send({ error: "agent_run_not_found" });
  }

  return snapshot;
});

server.get<{ Params: { id: string } }>("/agent/runs/:id/report", async (request, reply) => {
  const report = await agentRunReporter.report(request.params.id);
  if (!report) {
    return reply.code(404).send({ error: "agent_run_not_found" });
  }

  return report;
});

server.post<{ Params: { id: string } }>("/agent/runs/:id/plan", async (request, reply) => {
  const snapshot = await agentPlanner.plan(request.params.id);
  if (!snapshot) {
    return reply.code(404).send({ error: "agent_run_not_found" });
  }

  return snapshot;
});

server.post<{ Params: { id: string } }>(
  "/agent/runs/:id/advance",
  async (request, reply) => {
    const snapshot = await agentRuntime.advance(request.params.id);
    if (!snapshot) {
      return reply.code(404).send({ error: "agent_run_not_found" });
    }

    return snapshot;
  },
);

server.post<{
  Body: AgentAutoRunRequest;
  Params: { id: string };
}>("/agent/runs/:id/auto", async (request, reply) => {
  const result = await agentAutoRunner.run(request.params.id, request.body ?? {});
  if (!result) {
    return reply.code(404).send({ error: "agent_run_not_found" });
  }

  return result;
});

server.post<{
  Body: ToolExecuteRequest;
  Params: { id: string };
}>("/agent/runs/:id/tools/execute", async (request) => {
  return await agentToolExecutor.execute(request.params.id, request.body);
});

server.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "invalid_request",
      details: error.issues,
    });
  }

  const requestError = toRequestError(error);
  if (requestError && requestError.statusCode < 500) {
    return reply.code(requestError.statusCode).send({
      error: requestError.code ?? "request_error",
      message: requestError.message,
    });
  }

  server.log.error(error);
  return reply.code(500).send({ error: "internal_server_error" });
});

await server.listen({ port, host: "0.0.0.0" });

function toRequestError(
  error: unknown,
): { statusCode: number; code?: string; message: string } | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const maybeRequestError = error as Error & {
    statusCode?: unknown;
    code?: unknown;
  };

  if (typeof maybeRequestError.statusCode !== "number") {
    return undefined;
  }

  return {
    statusCode: maybeRequestError.statusCode,
    code: typeof maybeRequestError.code === "string" ? maybeRequestError.code : undefined,
    message: maybeRequestError.message,
  };
}

function createDynamicModelProviderAdapter(): ModelProviderAdapter {
  return {
    get provider() {
      return createModelProviderAdapter().provider;
    },
    async generate(input) {
      return await createModelProviderAdapter().generate(input);
    },
  };
}

function createDynamicEmbeddingProviderAdapter(): EmbeddingProviderAdapter {
  return {
    get provider() {
      return createEmbeddingProviderAdapter().provider;
    },
    async embed(input) {
      return await createEmbeddingProviderAdapter().embed(input);
    },
  };
}

function formatAnswerContext(results: Awaited<ReturnType<typeof dataStore.searchChunks>>): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.document.title}`,
        `Dataset: ${result.dataset.name}`,
        result.document.sourceUri ? `Source: ${result.document.sourceUri}` : undefined,
        `Distance: ${result.distance.toFixed(4)}`,
        result.chunk.content,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function rerankMemoryResults(
  results: Awaited<ReturnType<typeof dataStore.searchChunks>>,
  limit: number,
): Awaited<ReturnType<typeof dataStore.searchChunks>> {
  return [...results]
    .sort((left, right) => memoryResultScore(right) - memoryResultScore(left))
    .slice(0, limit);
}

function memoryResultScore(result: Awaited<ReturnType<typeof dataStore.searchChunks>>[number]): number {
  const source = (result.document.sourceUri ?? result.document.title).replace(/\\/g, "/").toLowerCase();
  const title = result.document.title.toLowerCase();
  const metadata = result.chunk.metadata as { kind?: unknown; generated?: unknown };
  let score = 1 - result.distance;

  if (metadata.kind === "workspace-overview" || source === "chenkoai://workspace-overview") {
    score += 2.5;
  }
  if (title.includes("workspace overview")) {
    score += 2;
  }
  if (source === "readme.md" || title === "readme.md") {
    score += 1.4;
  }
  if (source.startsWith("docs/")) {
    score += 1.1;
  }
  if (source.includes("architecture") || source.includes("roadmap")) {
    score += 0.8;
  }
  if (source.startsWith("apps/api/") || source.startsWith("packages/agent-core/")) {
    score += 0.4;
  }
  if (source.endsWith("cargo.toml") || source.endsWith("__init__.py")) {
    score -= 0.7;
  }
  if (source.includes(".example") || source.endsWith(".env")) {
    score -= 0.6;
  }

  return score;
}

async function fallBackToMemoryIfPostgresIsUnavailable(): Promise<void> {
  const postgresStores = [
    process.env.DATA_STORE,
    process.env.AGENT_RUN_STORE,
    process.env.PROMPT_REGISTRY_STORE,
    process.env.TOOL_PERMISSION_STORE,
  ].some((store) => store === "postgres");

  if (!postgresStores) {
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.env.CHENKOAI_STORAGE_DEGRADED_REASON =
      "PostgreSQL storage was requested, but DATABASE_URL is missing.";
    useMemoryStores();
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    await pool.query("select 1");
  } catch (error) {
    process.env.CHENKOAI_STORAGE_DEGRADED_REASON =
      error instanceof Error
        ? `PostgreSQL is unavailable: ${error.message}`
        : "PostgreSQL is unavailable.";
    useMemoryStores();
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function useMemoryStores(): void {
  process.env.CHENKOAI_CONFIGURED_DATA_STORE = process.env.DATA_STORE;
  process.env.CHENKOAI_CONFIGURED_AGENT_RUN_STORE = process.env.AGENT_RUN_STORE;
  process.env.CHENKOAI_CONFIGURED_PROMPT_REGISTRY_STORE = process.env.PROMPT_REGISTRY_STORE;
  process.env.CHENKOAI_CONFIGURED_TOOL_PERMISSION_STORE = process.env.TOOL_PERMISSION_STORE;
  process.env.DATA_STORE = "memory";
  process.env.AGENT_RUN_STORE = "memory";
  process.env.PROMPT_REGISTRY_STORE = "memory";
  process.env.TOOL_PERMISSION_STORE = "memory";
}
