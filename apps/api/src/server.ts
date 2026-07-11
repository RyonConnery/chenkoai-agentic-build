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
import {
  createStorageBackup,
  listStorageBackups,
  restoreStorageBackup,
} from "./storageBackup.js";
import { SystemScanner } from "./systemScanner.js";
import { createToolPermissionStore } from "./toolPermissionPersistence.js";

const port = Number(process.env.CHENKOAI_API_PORT ?? 8787);
await loadLocalSettingsIntoEnv();
await connectPostgresOrFallBackToMemory();
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
const runtimeStatusProvider = async () => formatRuntimeStatus();
const agentPlanner = new AgentPlanner(
  agentRunStore,
  modelProvider,
  agentMemoryRetriever,
  runtimeStatusProvider,
);
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
  runtimeStatusProvider,
);
const agentAutoRunner = new AgentAutoRunner(
  agentRunStore,
  agentPlanner,
  agentRuntime,
  toolPermissions,
);

server.addHook("onRequest", async (_request, reply) => {
  reply.header("Access-Control-Allow-Origin", process.env.CHENKOAI_DESKTOP_ORIGIN ?? "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
});

server.options("/*", async (_request, reply) => reply.code(204).send());

server.get("/health", async () => ({
  ok: true,
  service: "chenkoai-api",
  storageStatus: process.env.CHENKOAI_STORAGE_STATUS ?? "unknown",
  storageDegradedReason: process.env.CHENKOAI_STORAGE_DEGRADED_REASON,
}));

server.get("/system/status", async () => ({
  runtimeStatus: await formatRuntimeStatus(),
  model: readModelSettings(),
  storage: readStorageSettings(),
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

server.post("/settings/storage/reconnect", async () => {
  const storage = readStorageSettings();
  const postgresConfigured = storage.storageMode === "postgres";
  const connected = postgresConfigured ? await canConnectToPostgres() : false;
  const restartRequired = connected && storage.activeStorageMode !== "postgres";

  return {
    postgresConfigured,
    connected,
    activeStorageMode: storage.activeStorageMode,
    restartRequired,
    message: postgresConfigured
      ? connected
        ? restartRequired
          ? "PostgreSQL is reachable. Restart ChenkoAI to switch this API process back to durable storage."
          : "PostgreSQL is reachable and active."
        : "PostgreSQL is still unavailable. Start Docker Desktop/Postgres and try again."
      : "PostgreSQL is not configured for storage.",
  };
});

server.post<{ Body: StorageSettingsMutation }>("/settings/storage", async (request, reply) => {
  const settings = await saveStorageSettings(request.body ?? {});
  return reply.code(201).send({
    ...settings,
    restartRequired: true,
  });
});

server.get("/storage/backups", async () => listStorageBackups());

server.post("/storage/backups/export", async (request, reply) => {
  const result = await createStorageBackup(requireDatabaseUrl());
  return reply.code(201).send(result);
});

server.post<{ Body: { fileName?: string } }>("/storage/backups/restore", async (request) => {
  return await restoreStorageBackup(requireDatabaseUrl(), request.body?.fileName ?? "");
});

server.get("/system/profile", async () => systemScanner.profile());

server.post<{ Body: { maxFiles?: number; maxFileBytes?: number; mode?: "append" | "replace" } }>(
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

server.post<{ Params: { runId: string; permissionId: string } }>(
  "/agent/runs/:runId/permissions/:permissionId/execute",
  async (request, reply) => {
    const permissions = await toolPermissions.list();
    const permission = permissions.find(
      (candidate) => candidate.id === request.params.permissionId,
    );
    if (!permission) {
      return reply.code(404).send({ error: "tool_permission_not_found" });
    }

    return await agentToolExecutor.executeApprovedPermission(request.params.runId, permission);
  },
);

server.post<{ Body: TextIngestRequest }>("/data/ingest/text", async (request, reply) => {
  const result = await dataStore.ingestText(request.body);
  return reply.code(201).send(result);
});

server.post<{
  Body: TextIngestRequest & { evaluationQuery?: string };
}>("/data/ingest/selected", async (request, reply) => {
  const ingestResult = await dataStore.ingestText({
    ...request.body,
    metadata: {
      ...(request.body.metadata ?? {}),
      ingestionMode: "selected-content",
      selectedAt: new Date().toISOString(),
    },
  });
  let embeddedChunks = 0;
  let embeddingModel = "";

  for (const chunk of ingestResult.chunks) {
    const embedding = await embeddingProvider.embed(chunk.content);
    embeddingModel = embedding.model;
    await dataStore.saveChunkEmbedding(chunk.id, embedding.embedding, embedding.model);
    embeddedChunks += 1;
  }

  const query = request.body.evaluationQuery?.trim() || request.body.title;
  const queryEmbedding = await embeddingProvider.embed(query);
  const results = await dataStore.searchChunks({
    embedding: queryEmbedding.embedding,
    embeddingModel: queryEmbedding.model,
    datasetId: ingestResult.dataset.id,
    limit: 5,
  });
  const quality = await dataStore.getQualitySummary();
  const datasetQuality = quality.datasets.find(
    (dataset) => dataset.id === ingestResult.dataset.id,
  );

  return reply.code(201).send({
    ...ingestResult,
    embeddedChunks,
    embeddingProvider: embeddingProvider.provider,
    embeddingModel: embeddingModel || queryEmbedding.model,
    evaluationQuery: query,
    results,
    datasetQuality,
    quality,
  });
});

server.get("/data/datasets", async () => ({
  datasets: await dataStore.listDatasets(),
}));

server.get<{ Querystring: { datasetId?: string } }>("/data/documents", async (request) => ({
  documents: await dataStore.listDocuments(request.query.datasetId),
}));

server.get("/data/quality", async () => dataStore.getQualitySummary());

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
  const overviewIntent = isWorkspaceOverviewQuestion(searchRequest.query);
  const embedding = await embeddingProvider.embed(searchRequest.query);
  let candidates = await dataStore.searchChunks({
    embedding: embedding.embedding,
    embeddingModel: embedding.model,
    datasetId: searchRequest.datasetId,
    limit: Math.min(100, Math.max(finalLimit * 8, 30)),
  });

  if (overviewIntent) {
    const overviewEmbedding = await embeddingProvider.embed(workspaceOverviewSearchQuery());
    const overviewCandidates = await dataStore.searchChunks({
      embedding: overviewEmbedding.embedding,
      embeddingModel: overviewEmbedding.model,
      datasetId: searchRequest.datasetId,
      limit: 100,
    });
    candidates = mergeMemoryCandidates(candidates, overviewCandidates);
  }

  const results = rerankMemoryResults(candidates, finalLimit, { overviewIntent });
  const context = formatAnswerContext(results, { overviewIntent });
  const answerFormat = overviewIntent
    ? [
        "Answer format:",
        "Use short sections with these exact headings: Components, Working Now, Important Missing Production Work.",
        "Use dash bullets under each heading.",
        "Keep each bullet one sentence.",
        "Do not write numbered items inline in a paragraph.",
      ].join("\n")
    : "Answer format: Use concise paragraphs or bullets, whichever is clearest.";
  const generated = await modelProvider.generate({
    systemPrompt: [
      "You are ChenkoAI's memory analyst.",
      "Answer using only the provided memory context.",
      "When you use a source, cite it with bracket numbers like [1].",
      "Give a direct, useful answer when the memory context contains project overview or capability details.",
      "For workspace overview questions, summarize concrete product components, verified working capabilities, storage/model stack, and important missing production work.",
      "Keep current capabilities and future production work separate.",
      "Only say information is missing when the provided context truly lacks it.",
    ].join(" "),
    prompt: [
      `Question: ${searchRequest.query}`,
      "",
      answerFormat,
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

server.post<{ Body: { limit?: number } }>("/memory/evaluate", async (request) => {
  const limit = Math.max(1, Math.min(8, request.body?.limit ?? 5));
  const cases: MemoryEvaluationCaseResult[] = [];
  let provider = modelProvider.provider;
  let model = "";
  let embeddingProviderName = embeddingProvider.provider;
  let embeddingModel = "";

  for (const testCase of memoryEvaluationCases) {
    const embedding = await embeddingProvider.embed(testCase.query);
    embeddingProviderName = embedding.provider;
    embeddingModel = embedding.model;
    const candidates = await dataStore.searchChunks({
      embedding: embedding.embedding,
      embeddingModel: embedding.model,
      limit: Math.min(80, Math.max(limit * 8, 24)),
    });
    const results = rerankMemoryResults(candidates, limit, {
      overviewIntent: isWorkspaceOverviewQuestion(testCase.query),
      preferredSources: testCase.expectedSources,
    });
    const generated = await modelProvider.generate({
      systemPrompt: [
        "You are ChenkoAI's memory evaluator.",
        "Answer using only the provided memory context.",
        "Be direct and concrete.",
        "Cover every required concept when the memory context supports it.",
      ].join(" "),
      prompt: [
        `Question: ${testCase.query}`,
        "",
        "Required concepts to check:",
        testCase.expectedKeywords.join(", "),
        "",
        "Expected high-signal sources:",
        testCase.expectedSources.join(", "),
        "",
        "Memory context:",
        formatAnswerContext(results, {
          overviewIntent: isWorkspaceOverviewQuestion(testCase.query),
        }) || "No matching memory chunks were found.",
      ].join("\n"),
      temperature: 0.1,
      maxTokens: 420,
    });
    provider = generated.provider;
    model = generated.model;
    cases.push(scoreMemoryEvaluationCase(testCase, generated.text, results));
  }

  const passed = cases.filter((testCase) => testCase.passed).length;
  return {
    provider,
    model,
    embeddingProvider: embeddingProviderName,
    embeddingModel,
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      percent: cases.length === 0 ? 0 : Math.round((passed / cases.length) * 100),
    },
    cases,
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

function formatAnswerContext(
  results: Awaited<ReturnType<typeof dataStore.searchChunks>>,
  options: { overviewIntent?: boolean } = {},
): string {
  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.document.title}`,
        `Dataset: ${result.dataset.name}`,
        result.document.sourceUri ? `Source: ${result.document.sourceUri}` : undefined,
        `Distance: ${result.distance.toFixed(4)}`,
        options.overviewIntent ? `Source role: ${memoryResultRole(result)}` : undefined,
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
  options: { overviewIntent?: boolean; preferredSources?: string[] } = {},
): Awaited<ReturnType<typeof dataStore.searchChunks>> {
  const ranked = [...results].sort(
    (left, right) =>
      memoryResultScore(right, options) - memoryResultScore(left, options),
  );
  const selected: typeof ranked = [];
  const seenSources = new Set<string>();
  const seenChunks = new Set<string>();

  for (const result of ranked) {
    const sourceKey = memoryResultSourceKey(result);
    if (seenSources.has(sourceKey)) {
      continue;
    }

    selected.push(result);
    seenSources.add(sourceKey);
    seenChunks.add(result.chunk.id);

    if (selected.length >= limit) {
      return selected;
    }
  }

  for (const result of ranked) {
    if (seenChunks.has(result.chunk.id)) {
      continue;
    }

    selected.push(result);
    seenChunks.add(result.chunk.id);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function memoryResultSourceKey(
  result: Awaited<ReturnType<typeof dataStore.searchChunks>>[number],
): string {
  return (result.document.sourceUri ?? result.document.title)
    .replace(/\\/g, "/")
    .toLowerCase();
}

function memoryResultScore(
  result: Awaited<ReturnType<typeof dataStore.searchChunks>>[number],
  options: { overviewIntent?: boolean; preferredSources?: string[] } = {},
): number {
  const source = memoryResultSourceKey(result);
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
  if (options.preferredSources?.some((preferred) => source === preferred.toLowerCase())) {
    score += 3;
  }

  if (options.overviewIntent) {
    if (source === "readme.md" || title === "readme.md") {
      score += 2.4;
    }
    if (source === "docs/architecture.md") {
      score += 2.1;
    }
    if (source === "docs/roadmap.md" || source === "docs/data-ingestion.md") {
      score += 1.5;
    }
    if (source.endsWith("cargo.toml") || source.endsWith("package.json")) {
      score -= 1.2;
    }
    if (source.startsWith("apps/") || source.startsWith("packages/") || source.startsWith("crates/")) {
      score -= 0.9;
    }
    if (source.includes("localtools")) {
      score -= 1.4;
    }
  }

  return score;
}

function mergeMemoryCandidates(
  left: Awaited<ReturnType<typeof dataStore.searchChunks>>,
  right: Awaited<ReturnType<typeof dataStore.searchChunks>>,
): Awaited<ReturnType<typeof dataStore.searchChunks>> {
  const candidates = new Map<string, Awaited<ReturnType<typeof dataStore.searchChunks>>[number]>();

  for (const result of [...left, ...right]) {
    const existing = candidates.get(result.chunk.id);
    if (!existing || result.distance < existing.distance) {
      candidates.set(result.chunk.id, result);
    }
  }

  return [...candidates.values()];
}

function isWorkspaceOverviewQuestion(query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    "what does this workspace contain",
    "what is in this workspace",
    "main parts",
    "project contain",
    "workspace contain",
    "what is this project",
    "overview",
  ].some((phrase) => normalized.includes(phrase));
}

function workspaceOverviewSearchQuery(): string {
  return [
    "ChenkoAI workspace overview repository layout architecture roadmap current implemented capabilities",
    "desktop control center local API Ollama PostgreSQL pgvector memory scanner agent runtime",
    "core stack TypeScript Rust Python data ingestion durable storage prompts tools infrastructure",
  ].join(" ");
}

function memoryResultRole(
  result: Awaited<ReturnType<typeof dataStore.searchChunks>>[number],
): string {
  const source = memoryResultSourceKey(result);
  if (source === "chenkoai://workspace-overview") {
    return "generated project overview";
  }
  if (source === "readme.md") {
    return "repository layout and stack";
  }
  if (source.startsWith("docs/")) {
    return "architecture documentation";
  }
  if (source.endsWith("package.json") || source.endsWith("cargo.toml")) {
    return "build configuration";
  }
  return "implementation detail";
}

type MemoryEvaluationCase = {
  id: string;
  query: string;
  expectedKeywords: string[];
  expectedSources: string[];
};

type MemoryEvaluationCaseResult = {
  id: string;
  query: string;
  passed: boolean;
  score: number;
  answer: string;
  matchedKeywords: string[];
  missingKeywords: string[];
  matchedSources: string[];
  topSources: string[];
};

const memoryEvaluationCases: MemoryEvaluationCase[] = [
  {
    id: "workspace-overview",
    query: "What does this ChenkoAI workspace contain?",
    expectedKeywords: ["desktop", "api", "postgres", "ollama"],
    expectedSources: ["chenkoai://workspace-overview", "readme.md", "docs/architecture.md"],
  },
  {
    id: "durable-memory",
    query: "How does ChenkoAI store durable memory and searchable chunks?",
    expectedKeywords: ["postgres", "chunks", "embeddings", "pgvector"],
    expectedSources: ["docs/data-ingestion.md", "chenkoai://workspace-overview"],
  },
  {
    id: "safe-tools",
    query: "How should ChenkoAI safely execute local workspace tools?",
    expectedKeywords: ["permission", "approval", "tool", "workspace"],
    expectedSources: ["docs/local-tools.md", "chenkoai://workspace-overview"],
  },
  {
    id: "agent-memory",
    query: "How does ChenkoAI use memory during agent runs?",
    expectedKeywords: ["memory", "retrieval", "step", "agent"],
    expectedSources: ["docs/agent-run-lifecycle.md", "chenkoai://workspace-overview"],
  },
];

function scoreMemoryEvaluationCase(
  testCase: MemoryEvaluationCase,
  answer: string,
  results: Awaited<ReturnType<typeof dataStore.searchChunks>>,
): MemoryEvaluationCaseResult {
  const normalizedAnswer = answer.toLowerCase();
  const matchedKeywords = testCase.expectedKeywords.filter((keyword) =>
    normalizedAnswer.includes(keyword.toLowerCase()),
  );
  const missingKeywords = testCase.expectedKeywords.filter(
    (keyword) => !matchedKeywords.includes(keyword),
  );
  const topSources = results.map((result) =>
    (result.document.sourceUri ?? result.document.title).replace(/\\/g, "/").toLowerCase(),
  );
  const matchedSources = testCase.expectedSources.filter((source) =>
    topSources.some((candidate) => candidate === source.toLowerCase()),
  );
  const keywordScore = matchedKeywords.length / testCase.expectedKeywords.length;
  const sourceScore =
    testCase.expectedSources.length === 0
      ? 1
      : Math.min(1, matchedSources.length / Math.min(2, testCase.expectedSources.length));
  const score = Math.round((keywordScore * 0.7 + sourceScore * 0.3) * 100);

  return {
    id: testCase.id,
    query: testCase.query,
    passed: score >= 70,
    score,
    answer,
    matchedKeywords,
    missingKeywords,
    matchedSources,
    topSources: topSources.slice(0, 5),
  };
}

async function formatRuntimeStatus(): Promise<string> {
  const model = readModelSettings();
  const storage = readStorageSettings();
  const lines = [
    `Model provider: ${model.provider}`,
    `Local chat model: ${model.localModel}`,
    `Embedding provider: ${model.embeddingProvider}`,
    `Local embedding model: ${model.localEmbeddingModel}`,
    `Configured storage mode: ${storage.storageMode}`,
    `Active storage mode: ${storage.activeStorageMode}`,
    `Configured stores: data=${storage.dataStore}, agentRuns=${storage.agentRunStore}, prompts=${storage.promptRegistryStore}, toolPermissions=${storage.toolPermissionStore}`,
    `Active stores: data=${storage.activeDataStore}, agentRuns=${storage.activeAgentRunStore}, prompts=${storage.activePromptRegistryStore}, toolPermissions=${storage.activeToolPermissionStore}`,
    `Database URL configured: ${storage.hasDatabaseUrl ? "yes" : "no"}`,
    `Storage degraded: ${storage.storageDegradedReason ?? "no"}`,
  ];

  return lines.join("\n");
}

async function connectPostgresOrFallBackToMemory(): Promise<void> {
  const postgresStores = [
    process.env.DATA_STORE,
    process.env.AGENT_RUN_STORE,
    process.env.PROMPT_REGISTRY_STORE,
    process.env.TOOL_PERMISSION_STORE,
  ].some((store) => store === "postgres");

  if (!postgresStores) {
    process.env.CHENKOAI_STORAGE_STATUS = "memory";
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.env.CHENKOAI_STORAGE_DEGRADED_REASON =
      "PostgreSQL storage was requested, but DATABASE_URL is missing.";
    process.env.CHENKOAI_STORAGE_STATUS = "degraded";
    useMemoryStores();
    return;
  }

  process.env.CHENKOAI_STORAGE_STATUS = "starting";
  const attempts = Number(process.env.CHENKOAI_POSTGRES_STARTUP_ATTEMPTS ?? 30);
  const delayMs = Number(process.env.CHENKOAI_POSTGRES_STARTUP_DELAY_MS ?? 2000);
  let lastError = "";

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const result = await tryConnectToPostgres(connectionString);
    if (result.ok) {
      delete process.env.CHENKOAI_STORAGE_DEGRADED_REASON;
      process.env.CHENKOAI_STORAGE_STATUS = "connected";
      return;
    }

    lastError = result.error;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  process.env.CHENKOAI_STORAGE_DEGRADED_REASON =
    lastError || "PostgreSQL is unavailable after startup retries.";
  process.env.CHENKOAI_STORAGE_STATUS = "degraded";
  useMemoryStores();
}

async function canConnectToPostgres(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return false;
  }

  return (await tryConnectToPostgres(connectionString)).ok;
}

async function tryConnectToPostgres(
  connectionString: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("select 1");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? `PostgreSQL is unavailable: ${error.message}`
          : "PostgreSQL is unavailable.",
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for ChenkoAI storage backups.");
  }

  return databaseUrl;
}
