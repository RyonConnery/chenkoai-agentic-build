import { Pool } from "pg";
import {
  InMemoryPromptRegistry,
  type PromptRegistry,
} from "./promptRegistry.js";
import { PostgresPromptRegistry } from "./postgresPromptRegistry.js";

export async function createPromptRegistry(): Promise<PromptRegistry> {
  const store = process.env.PROMPT_REGISTRY_STORE ?? "memory";

  if (store === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when PROMPT_REGISTRY_STORE=postgres");
    }

    const registry = new PostgresPromptRegistry(new Pool({ connectionString }));
    await registry.seedDefaults();
    return registry;
  }

  return new InMemoryPromptRegistry();
}
