import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

const backupFormat = "chenkoai.postgres.backup.v1";
const backupDirectory = path.join(process.cwd(), "backups");

const backupTables = [
  "data_datasets",
  "data_documents",
  "data_chunks",
  "agent_runs",
  "agent_run_steps",
  "agent_run_events",
  "prompt_templates",
  "tool_permission_requests",
] as const;

type BackupTable = (typeof backupTables)[number];
type BackupRows = Record<BackupTable, QueryResultRow[]>;

type StorageBackupManifest = {
  format: typeof backupFormat;
  createdAt: string;
  tables: BackupRows;
};

export type StorageBackupSummary = {
  fileName: string;
  filePath: string;
  createdAt: string;
  bytes: number;
  counts: Record<BackupTable, number>;
};

export async function listStorageBackups(): Promise<{ backups: StorageBackupSummary[] }> {
  await ensureBackupDirectory();
  const entries = await readdir(backupDirectory, { withFileTypes: true });
  const backups: StorageBackupSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isBackupFileName(entry.name)) {
      continue;
    }

    const filePath = path.join(backupDirectory, entry.name);
    const [details, file] = await Promise.all([stat(filePath), readBackupFile(filePath)]);
    backups.push(toSummary(entry.name, filePath, details.size, file));
  }

  return {
    backups: backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}

export async function createStorageBackup(
  connectionString: string,
): Promise<StorageBackupSummary> {
  await ensureBackupDirectory();
  const pool = new Pool({ connectionString });
  try {
    const createdAt = new Date().toISOString();
    const tables: BackupRows = {
      data_datasets: await selectRows(pool, "select * from data_datasets order by name"),
      data_documents: await selectRows(
        pool,
        "select * from data_documents order by dataset_id, source_uri nulls last, title, created_at",
      ),
      data_chunks: await selectRows(
        pool,
        `select id, document_id, dataset_id, chunk_index, content, token_estimate, metadata,
                created_at, embedding::text as embedding, embedding_model, embedded_at
           from data_chunks
          order by dataset_id, document_id, chunk_index`,
      ),
      agent_runs: await selectRows(pool, "select * from agent_runs order by created_at, id"),
      agent_run_steps: await selectRows(
        pool,
        "select * from agent_run_steps order by run_id, step_index",
      ),
      agent_run_events: await selectRows(
        pool,
        "select * from agent_run_events order by run_id, created_at, id",
      ),
      prompt_templates: await selectRows(
        pool,
        "select * from prompt_templates order by id, version",
      ),
      tool_permission_requests: await selectRows(
        pool,
        "select * from tool_permission_requests order by created_at, id",
      ),
    };

    const backup: StorageBackupManifest = {
      format: backupFormat,
      createdAt,
      tables,
    };
    const fileName = `chenkoai-postgres-backup-${createdAt.replace(/[:.]/g, "-")}.json`;
    const filePath = path.join(backupDirectory, fileName);
    await writeFile(filePath, JSON.stringify(backup, null, 2), "utf8");
    const details = await stat(filePath);

    return toSummary(fileName, filePath, details.size, backup);
  } finally {
    await pool.end();
  }
}

export async function restoreStorageBackup(
  connectionString: string,
  fileName: string,
): Promise<{ restored: Record<BackupTable, number>; backup: StorageBackupSummary }> {
  if (!isBackupFileName(fileName)) {
    throw new Error("A valid ChenkoAI backup file name is required.");
  }

  const filePath = path.join(backupDirectory, path.basename(fileName));
  const [details, backup] = await Promise.all([stat(filePath), readBackupFile(filePath)]);
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  const restored = emptyCounts();

  try {
    await client.query("begin");

    for (const row of backup.tables.data_datasets) {
      await upsertDataset(client, row);
      restored.data_datasets += 1;
    }
    for (const row of backup.tables.data_documents) {
      await upsertDocument(client, row);
      restored.data_documents += 1;
    }
    for (const row of backup.tables.data_chunks) {
      await upsertChunk(client, row);
      restored.data_chunks += 1;
    }
    for (const row of backup.tables.agent_runs) {
      await upsertAgentRun(client, row);
      restored.agent_runs += 1;
    }
    for (const row of backup.tables.agent_run_steps) {
      await upsertAgentRunStep(client, row);
      restored.agent_run_steps += 1;
    }
    for (const row of backup.tables.agent_run_events) {
      await upsertAgentRunEvent(client, row);
      restored.agent_run_events += 1;
    }
    for (const row of backup.tables.prompt_templates) {
      await upsertPromptTemplate(client, row);
      restored.prompt_templates += 1;
    }
    for (const row of backup.tables.tool_permission_requests) {
      await upsertToolPermission(client, row);
      restored.tool_permission_requests += 1;
    }

    await client.query("commit");
    return {
      restored,
      backup: toSummary(path.basename(fileName), filePath, details.size, backup),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function selectRows(pool: Pool, sql: string): Promise<QueryResultRow[]> {
  return (await pool.query(sql)).rows;
}

async function ensureBackupDirectory(): Promise<void> {
  await mkdir(backupDirectory, { recursive: true });
}

async function readBackupFile(filePath: string): Promise<StorageBackupManifest> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as StorageBackupManifest;
  if (parsed.format !== backupFormat || !parsed.tables) {
    throw new Error("Backup file is not a supported ChenkoAI storage backup.");
  }

  for (const table of backupTables) {
    if (!Array.isArray(parsed.tables[table])) {
      throw new Error(`Backup file is missing table ${table}.`);
    }
  }

  return parsed;
}

function toSummary(
  fileName: string,
  filePath: string,
  bytes: number,
  backup: StorageBackupManifest,
): StorageBackupSummary {
  const counts = emptyCounts();
  for (const table of backupTables) {
    counts[table] = backup.tables[table].length;
  }

  return {
    fileName,
    filePath,
    createdAt: backup.createdAt,
    bytes,
    counts,
  };
}

function emptyCounts(): Record<BackupTable, number> {
  return {
    data_datasets: 0,
    data_documents: 0,
    data_chunks: 0,
    agent_runs: 0,
    agent_run_steps: 0,
    agent_run_events: 0,
    prompt_templates: 0,
    tool_permission_requests: 0,
  };
}

function isBackupFileName(fileName: string): boolean {
  return (
    path.basename(fileName) === fileName &&
    fileName.startsWith("chenkoai-postgres-backup-") &&
    fileName.endsWith(".json")
  );
}

async function upsertDataset(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into data_datasets (id, name, description, created_at, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set
       name = excluded.name,
       description = excluded.description,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [row.id, row.name, row.description, row.created_at, row.updated_at],
  );
}

async function upsertDocument(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into data_documents
       (id, dataset_id, title, source_type, source_uri, metadata, content_hash, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     on conflict (id) do update set
       dataset_id = excluded.dataset_id,
       title = excluded.title,
       source_type = excluded.source_type,
       source_uri = excluded.source_uri,
       metadata = excluded.metadata,
       content_hash = excluded.content_hash,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.dataset_id,
      row.title,
      row.source_type,
      row.source_uri,
      JSON.stringify(row.metadata ?? {}),
      row.content_hash,
      row.created_at,
      row.updated_at,
    ],
  );
}

async function upsertChunk(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into data_chunks
       (id, document_id, dataset_id, chunk_index, content, token_estimate, metadata, created_at,
        embedding, embedding_model, embedded_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::vector, $10, $11)
     on conflict (id) do update set
       document_id = excluded.document_id,
       dataset_id = excluded.dataset_id,
       chunk_index = excluded.chunk_index,
       content = excluded.content,
       token_estimate = excluded.token_estimate,
       metadata = excluded.metadata,
       created_at = excluded.created_at,
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       embedded_at = excluded.embedded_at`,
    [
      row.id,
      row.document_id,
      row.dataset_id,
      row.chunk_index,
      row.content,
      row.token_estimate,
      JSON.stringify(row.metadata ?? {}),
      row.created_at,
      row.embedding,
      row.embedding_model,
      row.embedded_at,
    ],
  );
}

async function upsertAgentRun(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into agent_runs (id, status, goal, context, max_steps, plan, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       status = excluded.status,
       goal = excluded.goal,
       context = excluded.context,
       max_steps = excluded.max_steps,
       plan = excluded.plan,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [row.id, row.status, row.goal, row.context, row.max_steps, row.plan, row.created_at, row.updated_at],
  );
}

async function upsertAgentRunStep(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into agent_run_steps
       (id, run_id, step_index, title, status, details, started_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id) do update set
       run_id = excluded.run_id,
       step_index = excluded.step_index,
       title = excluded.title,
       status = excluded.status,
       details = excluded.details,
       started_at = excluded.started_at,
       completed_at = excluded.completed_at`,
    [
      row.id,
      row.run_id,
      row.step_index,
      row.title,
      row.status,
      row.details,
      row.started_at,
      row.completed_at,
    ],
  );
}

async function upsertAgentRunEvent(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into agent_run_events (id, run_id, type, message, created_at)
     values ($1, $2, $3, $4, $5)
     on conflict (id) do update set
       run_id = excluded.run_id,
       type = excluded.type,
       message = excluded.message,
       created_at = excluded.created_at`,
    [row.id, row.run_id, row.type, row.message, row.created_at],
  );
}

async function upsertPromptTemplate(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into prompt_templates
       (id, version, description, system, user_template, active, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (id, version) do update set
       description = excluded.description,
       system = excluded.system,
       user_template = excluded.user_template,
       active = excluded.active,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
      row.id,
      row.version,
      row.description,
      row.system,
      row.user_template,
      row.active,
      row.created_at,
      row.updated_at,
    ],
  );
}

async function upsertToolPermission(client: PoolClient, row: QueryResultRow): Promise<void> {
  await client.query(
    `insert into tool_permission_requests
       (id, tool_name, tool_input, input_key, status, reason, created_at, decided_at, decided_by)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     on conflict (id) do update set
       tool_name = excluded.tool_name,
       tool_input = excluded.tool_input,
       input_key = excluded.input_key,
       status = excluded.status,
       reason = excluded.reason,
       created_at = excluded.created_at,
       decided_at = excluded.decided_at,
       decided_by = excluded.decided_by`,
    [
      row.id,
      row.tool_name,
      JSON.stringify(row.tool_input ?? {}),
      row.input_key,
      row.status,
      row.reason,
      row.created_at,
      row.decided_at,
      row.decided_by,
    ],
  );
}
