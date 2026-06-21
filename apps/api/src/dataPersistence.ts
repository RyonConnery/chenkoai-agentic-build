import { Pool } from "pg";
import { InMemoryDataStore, type DataStore } from "./dataStore.js";
import { PostgresDataStore } from "./postgresDataStore.js";

export function createDataStore(): DataStore {
  const store = process.env.DATA_STORE ?? "memory";

  if (store === "postgres") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is required when DATA_STORE=postgres");
    }

    return new PostgresDataStore(new Pool({ connectionString }));
  }

  return new InMemoryDataStore();
}
