import Fastify from "fastify";
import { createAgentRun, type AgentRunRequest } from "@chenkoai/agent-core";

const port = Number(process.env.CHENKOAI_API_PORT ?? 8787);
const server = Fastify({ logger: true });

server.get("/health", async () => ({
  ok: true,
  service: "chenkoai-api",
}));

server.post<{ Body: AgentRunRequest }>("/agent/run", async (request) => {
  return createAgentRun(request.body);
});

await server.listen({ port, host: "0.0.0.0" });

