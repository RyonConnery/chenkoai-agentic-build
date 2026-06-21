import Fastify from "fastify";
import { type AgentRunRequest } from "@chenkoai/agent-core";
import { ZodError } from "zod";
import { createAgentRunStore } from "./agentRunPersistence.js";

const port = Number(process.env.CHENKOAI_API_PORT ?? 8787);
const server = Fastify({ logger: true });
const agentRunStore = createAgentRunStore();

server.get("/health", async () => ({
  ok: true,
  service: "chenkoai-api",
}));

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
    const snapshot = await agentRunStore.advance(request.params.id);
    if (!snapshot) {
      return reply.code(404).send({ error: "agent_run_not_found" });
    }

    return snapshot;
  },
);

server.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "invalid_agent_run_request",
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
