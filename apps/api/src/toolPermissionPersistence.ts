import { Pool } from "pg";
import {
  InMemoryToolPermissionStore,
  type ToolPermissionStore,
} from "./toolPermissions.js";
import { PostgresToolPermissionStore } from "./postgresToolPermissionStore.js";

export function createToolPermissionStore(): ToolPermissionStore {
  const store = process.env.TOOL_PERMISSION_STORE ?? "memory";

  if (store === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when TOOL_PERMISSION_STORE=postgres");
    }

    return new PostgresToolPermissionStore(new Pool({ connectionString }));
  }

  return new InMemoryToolPermissionStore();
}
