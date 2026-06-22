import {
  normalizeTextIngestRequest,
  type DataChunk,
  type DataDataset,
  type DataDocument,
  type DataSearchResult,
  type TextIngestRequest,
  type TextIngestResult,
} from "@chenkoai/agent-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  createChunks,
  hashText,
  summarizeQuality,
  type DataDatasetDeleteResult,
  type DataDatasetQuality,
  type DataDocumentListItem,
  type DataQualitySummary,
  type DataStore,
} from "./dataStore.js";

type DatasetRow = QueryResultRow & {
  id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
};

type DocumentRow = QueryResultRow & {
  id: string;
  dataset_id: string;
  title: string;
  source_type: DataDocument["sourceType"];
  source_uri: string | null;
  metadata: Record<string, unknown>;
  content_hash: string;
  created_at: Date;
  updated_at: Date;
  chunk_count?: string;
};

type ChunkRow = QueryResultRow & {
  id: string;
  document_id: string;
  dataset_id: string;
  chunk_index: number;
  content: string;
  token_estimate: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  embedding_model: string | null;
  embedded_at: Date | null;
};

type ChunkSearchRow = ChunkRow & {
  document_title: string;
  document_source_type: DataDocument["sourceType"];
  document_source_uri: string | null;
  dataset_name: string;
  distance: string;
};

export class PostgresDataStore implements DataStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ingestText(input: TextIngestRequest): Promise<TextIngestResult> {
    const request = normalizeTextIngestRequest(input);
    const now = new Date().toISOString();

    return this.#withTransaction(async (client) => {
      const dataset = await this.#getOrCreateDataset(client, request.datasetName, now);
      const contentHash = hashText(request.text);
      const existing = await this.#findExistingDocument(
        client,
        dataset.id,
        request.sourceUri ?? request.title,
        contentHash,
      );
      if (existing) {
        return {
          dataset,
          document: existing,
          chunks: await this.#listChunks(client, existing.id),
        };
      }

      const document: DataDocument = {
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        title: request.title,
        sourceType: request.sourceType,
        sourceUri: request.sourceUri,
        metadata: request.metadata,
        contentHash,
        createdAt: now,
        updatedAt: now,
      };
      const chunks = createChunks(dataset.id, document.id, request.text, request.metadata, now);

      await client.query(
        `insert into data_documents
         (id, dataset_id, title, source_type, source_uri, metadata, content_hash, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          document.id,
          document.datasetId,
          document.title,
          document.sourceType,
          document.sourceUri ?? null,
          document.metadata,
          document.contentHash,
          document.createdAt,
          document.updatedAt,
        ],
      );

      for (const chunk of chunks) {
        await client.query(
          `insert into data_chunks
           (id, document_id, dataset_id, chunk_index, content, token_estimate, metadata, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            chunk.id,
            chunk.documentId,
            chunk.datasetId,
            chunk.chunkIndex,
            chunk.content,
            chunk.tokenEstimate,
            chunk.metadata,
            chunk.createdAt,
          ],
        );
      }

      return {
        dataset,
        document,
        chunks,
      };
    });
  }

  async listDatasets(): Promise<DataDataset[]> {
    const result = await this.#pool.query<DatasetRow>(
      `select id, name, description, created_at, updated_at
       from data_datasets
       order by name asc`,
    );

    return result.rows.map(mapDataset);
  }

  async listDocuments(datasetId?: string): Promise<DataDocumentListItem[]> {
    const params = datasetId ? [datasetId] : [];
    const result = await this.#pool.query<DocumentRow>(
      `select d.id, d.dataset_id, d.title, d.source_type, d.source_uri, d.metadata,
              d.content_hash, d.created_at, d.updated_at, count(c.id)::text as chunk_count
       from data_documents d
       left join data_chunks c on c.document_id = d.id
       ${datasetId ? "where d.dataset_id = $1" : ""}
       group by d.id
       order by d.created_at desc`,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      datasetId: row.dataset_id,
      title: row.title,
      sourceType: row.source_type,
      sourceUri: row.source_uri ?? undefined,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      chunkCount: Number(row.chunk_count ?? 0),
    }));
  }

  async getDocument(id: string): Promise<DataDocument | undefined> {
    const result = await this.#pool.query<DocumentRow>(
      `select id, dataset_id, title, source_type, source_uri, metadata, content_hash, created_at, updated_at
       from data_documents
       where id = $1`,
      [id],
    );

    const row = result.rows[0];
    return row ? mapDocument(row) : undefined;
  }

  async listChunks(documentId: string): Promise<DataChunk[]> {
    return await this.#listChunks(this.#pool, documentId);
  }

  async getQualitySummary(): Promise<DataQualitySummary> {
    const result = await this.#pool.query<
      QueryResultRow & {
        id: string;
        name: string;
        updated_at: Date;
        document_count: string;
        chunk_count: string;
        embedded_chunk_count: string;
        duplicate_document_count: string | null;
      }
    >(
      `select ds.id,
              ds.name,
              ds.updated_at,
              coalesce(doc.document_count, 0)::text as document_count,
              coalesce(chunks.chunk_count, 0)::text as chunk_count,
              coalesce(chunks.embedded_chunk_count, 0)::text as embedded_chunk_count,
              coalesce(dup.duplicate_document_count, 0)::text as duplicate_document_count
       from data_datasets ds
       left join (
         select dataset_id, count(*) as document_count
         from data_documents
         group by dataset_id
       ) doc on doc.dataset_id = ds.id
       left join (
         select dataset_id,
                count(*) as chunk_count,
                count(*) filter (where embedding is not null) as embedded_chunk_count
         from data_chunks
         group by dataset_id
       ) chunks on chunks.dataset_id = ds.id
       left join (
         select dataset_id, sum(document_count - 1)::text as duplicate_document_count
         from (
           select dataset_id, coalesce(source_uri, title), content_hash, count(*) as document_count
           from data_documents
           group by dataset_id, coalesce(source_uri, title), content_hash
           having count(*) > 1
         ) grouped_duplicates
         group by dataset_id
       ) dup on dup.dataset_id = ds.id
       order by ds.updated_at desc`,
    );

    const datasets: DataDatasetQuality[] = result.rows.map((row) => {
      const chunkCount = Number(row.chunk_count);
      const embeddedChunkCount = Number(row.embedded_chunk_count);

      return {
        id: row.id,
        name: row.name,
        updatedAt: toIso(row.updated_at),
        documentCount: Number(row.document_count),
        chunkCount,
        embeddedChunkCount,
        unembeddedChunkCount: Math.max(0, chunkCount - embeddedChunkCount),
        duplicateDocumentCount: Number(row.duplicate_document_count ?? 0),
      };
    });

    return summarizeQuality(datasets);
  }

  async deleteDatasetByName(datasetName: string): Promise<DataDatasetDeleteResult> {
    return await this.#withTransaction(async (client) => {
      const datasetResult = await client.query<DatasetRow>(
        `select id, name, description, created_at, updated_at
         from data_datasets
         where name = $1`,
        [datasetName],
      );
      const dataset = datasetResult.rows[0];
      if (!dataset) {
        return { deleted: false, datasetName, documentCount: 0, chunkCount: 0 };
      }

      const countResult = await client.query<
        QueryResultRow & { document_count: string; chunk_count: string }
      >(
        `select count(distinct d.id)::text as document_count,
                count(c.id)::text as chunk_count
         from data_documents d
         left join data_chunks c on c.document_id = d.id
         where d.dataset_id = $1`,
        [dataset.id],
      );

      await client.query(`delete from data_datasets where id = $1`, [dataset.id]);

      return {
        deleted: true,
        datasetName,
        documentCount: Number(countResult.rows[0]?.document_count ?? 0),
        chunkCount: Number(countResult.rows[0]?.chunk_count ?? 0),
      };
    });
  }

  async #listChunks(client: Pool | PoolClient, documentId: string): Promise<DataChunk[]> {
    const result = await client.query<ChunkRow>(
      `select id, document_id, dataset_id, chunk_index, content, token_estimate,
              metadata, created_at, embedding_model, embedded_at
       from data_chunks
       where document_id = $1
       order by chunk_index asc`,
      [documentId],
    );

    return result.rows.map(mapChunk);
  }

  async listChunksNeedingEmbedding(limit: number, datasetId?: string): Promise<DataChunk[]> {
    const params: Array<string | number> = datasetId ? [datasetId, limit] : [limit];
    const result = await this.#pool.query<ChunkRow>(
      `select id, document_id, dataset_id, chunk_index, content, token_estimate,
              metadata, created_at, embedding_model, embedded_at
       from data_chunks
       where embedding is null
       ${datasetId ? "and dataset_id = $1" : ""}
       order by created_at asc, chunk_index asc
       limit $${datasetId ? 2 : 1}`,
      params,
    );

    return result.rows.map(mapChunk);
  }

  async saveChunkEmbedding(chunkId: string, embedding: number[], model: string): Promise<void> {
    await this.#pool.query(
      `update data_chunks
       set embedding = $2::vector,
           embedding_model = $3,
           embedded_at = now()
       where id = $1`,
      [chunkId, toVector(embedding), model],
    );
  }

  async searchChunks(input: {
    embedding: number[];
    embeddingModel?: string;
    datasetId?: string;
    limit: number;
  }): Promise<DataSearchResult[]> {
    const params: Array<string | number> = [toVector(input.embedding)];
    const filters = ["c.embedding is not null"];

    if (input.embeddingModel) {
      params.push(input.embeddingModel);
      filters.push(`c.embedding_model = $${params.length}`);
    }

    if (input.datasetId) {
      params.push(input.datasetId);
      filters.push(`c.dataset_id = $${params.length}`);
    }

    params.push(input.limit);
    const result = await this.#pool.query<ChunkSearchRow>(
      `select c.id, c.document_id, c.dataset_id, c.chunk_index, c.content,
              c.token_estimate, c.metadata, c.created_at, c.embedding_model,
              c.embedded_at, d.title as document_title,
              d.source_type as document_source_type, d.source_uri as document_source_uri,
              ds.name as dataset_name,
              (c.embedding <=> $1::vector)::text as distance
       from data_chunks c
       join data_documents d on d.id = c.document_id
       join data_datasets ds on ds.id = c.dataset_id
       where ${filters.join(" and ")}
       order by c.embedding <=> $1::vector
       limit $${params.length}`,
      params,
    );

    return result.rows.map((row) => ({
      chunk: mapChunk(row),
      document: {
        id: row.document_id,
        title: row.document_title,
        sourceType: row.document_source_type,
        sourceUri: row.document_source_uri ?? undefined,
      },
      dataset: {
        id: row.dataset_id,
        name: row.dataset_name,
      },
      distance: Number(row.distance),
    }));
  }

  async #getOrCreateDataset(
    client: PoolClient,
    name: string,
    now: string,
  ): Promise<DataDataset> {
    const result = await client.query<DatasetRow>(
      `insert into data_datasets (id, name, created_at, updated_at)
       values ($1, $2, $3, $4)
       on conflict (name) do update set updated_at = excluded.updated_at
       returning id, name, description, created_at, updated_at`,
      [crypto.randomUUID(), name, now, now],
    );

    return mapDataset(result.rows[0]!);
  }

  async #findExistingDocument(
    client: PoolClient,
    datasetId: string,
    sourceKey: string,
    contentHash: string,
  ): Promise<DataDocument | undefined> {
    const result = await client.query<DocumentRow>(
      `select id, dataset_id, title, source_type, source_uri, metadata, content_hash, created_at, updated_at
       from data_documents
       where dataset_id = $1
         and coalesce(source_uri, title) = $2
         and content_hash = $3
       order by created_at desc
       limit 1`,
      [datasetId, sourceKey, contentHash],
    );

    const row = result.rows[0];
    return row ? mapDocument(row) : undefined;
  }

  async #withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();

    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapDataset(row: DatasetRow): DataDataset {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapDocument(row: DocumentRow): DataDocument {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    title: row.title,
    sourceType: row.source_type,
    sourceUri: row.source_uri ?? undefined,
    metadata: row.metadata,
    contentHash: row.content_hash,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapChunk(row: ChunkRow): DataChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    datasetId: row.dataset_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    tokenEstimate: row.token_estimate,
    metadata: row.metadata,
    createdAt: toIso(row.created_at),
    embeddingModel: row.embedding_model ?? undefined,
    embeddedAt: row.embedded_at ? toIso(row.embedded_at) : undefined,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toVector(values: number[]): string {
  return `[${values.join(",")}]`;
}
