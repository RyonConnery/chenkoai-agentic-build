import Fastify from "fastify";
import {
  type AgentRunRequest,
  type DataSearchRequest,
  type EmbeddingRebuildRequest,
  type ModelGenerateRequest,
  type PromptTemplateMutationRequest,
  type TextIngestRequest,
  type ToolExecuteRequest,
  normalizeDataSearchRequest,
  normalizeEmbeddingRebuildRequest,
} from "@chenkoai/agent-core";
import { ZodError } from "zod";
import { AgentMemoryRetriever } from "./agentMemory.js";
import { createAgentRunStore } from "./agentRunPersistence.js";
import { AgentRuntime } from "./agentRuntime.js";
import { createDataStore } from "./dataPersistence.js";
import { createEmbeddingProviderAdapter } from "./embeddingProvider.js";
import { LocalToolRegistry } from "./localTools.js";
import { createModelProviderAdapter } from "./modelProvider.js";
import { createPromptRegistry } from "./promptRegistryPersistence.js";

const port = Number(process.env.CHENKOAI_API_PORT ?? 8787);
const server = Fastify({ logger: true });
const agentRunStore = createAgentRunStore();
const dataStore = createDataStore();
const embeddingProvider = createEmbeddingProviderAdapter();
const localTools = new LocalToolRegistry();
const modelProvider = createModelProviderAdapter();
const promptRegistry = await createPromptRegistry();
const agentMemoryRetriever = new AgentMemoryRetriever(dataStore, embeddingProvider);
const agentRuntime = new AgentRuntime(
  agentRunStore,
  modelProvider,
  promptRegistry,
  agentMemoryRetriever,
);

server.get("/health", async () => ({
  ok: true,
  service: "chenkoai-api",
}));

server.get("/model/provider", async () => ({
  provider: modelProvider.provider,
}));

server.get("/embeddings/provider", async () => ({
  provider: embeddingProvider.provider,
}));

server.post<{ Body: ModelGenerateRequest }>("/model/generate", async (request) => {
  return await modelProvider.generate(request.body);
});

server.get("/tools", async () => ({
  tools: localTools.list(),
}));

server.post<{ Body: ToolExecuteRequest }>("/tools/execute", async (request) => {
  return await localTools.execute(request.body);
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
    datasetId: searchRequest.datasetId,
    limit: searchRequest.limit,
  });

  return {
    provider: response.provider,
    model: response.model,
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
