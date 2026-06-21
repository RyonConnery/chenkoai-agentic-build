import { Pool } from "pg";
import { InMemoryAgentRunStore, type AgentRunStore } from "./agentRunStore.js";
import { PostgresAgentRunStore } from "./postgresAgentRunStore.js";

export function createAgentRunStore(): AgentRunStore {
  const store = process.env.AGENT_RUN_STORE ?? "memory";

  if (store === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when AGENT_RUN_STORE=postgres");
    }

    return new PostgresAgentRunStore(new Pool({ connectionString }));
  }

  return new InMemoryAgentRunStore();
}

