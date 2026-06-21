import { createHash } from "node:crypto";
import {
  normalizeTextIngestRequest,
  type DataChunk,
  type DataDataset,
  type DataDocument,
  type DataSearchResult,
  type TextIngestRequest,
  type TextIngestResult,
} from "@chenkoai/agent-core";
import { chunkText, estimateTokens } from "./dataChunking.js";

export type DataDocumentListItem = Pick<
  DataDocument,
  "id" | "datasetId" | "title" | "sourceType" | "sourceUri" | "createdAt" | "updatedAt"
> & {
  chunkCount: number;
};

export interface DataStore {
  ingestText(input: TextIngestRequest): Promise<TextIngestResult>;
  listDatasets(): Promise<DataDataset[]>;
  listDocuments(datasetId?: string): Promise<DataDocumentListItem[]>;
  getDocument(id: string): Promise<DataDocument | undefined>;
  listChunks(documentId: string): Promise<DataChunk[]>;
  listChunksNeedingEmbedding(limit: number, datasetId?: string): Promise<DataChunk[]>;
  saveChunkEmbedding(chunkId: string, embedding: number[], model: string): Promise<void>;
  searchChunks(input: {
    embedding: number[];
    datasetId?: string;
    limit: number;
  }): Promise<DataSearchResult[]>;
}

export class InMemoryDataStore implements DataStore {
  readonly #datasetsByName = new Map<string, DataDataset>();
  readonly #documents = new Map<string, DataDocument>();
  readonly #chunksByDocument = new Map<string, DataChunk[]>();
  readonly #embeddingsByChunk = new Map<string, number[]>();

  async ingestText(input: TextIngestRequest): Promise<TextIngestResult> {
    const request = normalizeTextIngestRequest(input);
    const now = new Date().toISOString();
    const dataset = this.#getOrCreateDataset(request.datasetName, now);
    const document: DataDocument = {
      id: crypto.randomUUID(),
      datasetId: dataset.id,
      title: request.title,
      sourceType: request.sourceType,
      sourceUri: request.sourceUri,
      metadata: request.metadata,
      contentHash: hashText(request.text),
      createdAt: now,
      updatedAt: now,
    };
    const chunks = createChunks(dataset.id, document.id, request.text, request.metadata, now);

    this.#documents.set(document.id, document);
    this.#chunksByDocument.set(document.id, chunks);

    return {
      dataset,
      document,
      chunks,
    };
  }

  async listDatasets(): Promise<DataDataset[]> {
    return [...this.#datasetsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listDocuments(datasetId?: string): Promise<DataDocumentListItem[]> {
    return [...this.#documents.values()]
      .filter((document) => !datasetId || document.datasetId === datasetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((document) => ({
        id: document.id,
        datasetId: document.datasetId,
        title: document.title,
        sourceType: document.sourceType,
        sourceUri: document.sourceUri,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        chunkCount: this.#chunksByDocument.get(document.id)?.length ?? 0,
      }));
  }

  async getDocument(id: string): Promise<DataDocument | undefined> {
    return this.#documents.get(id);
  }

  async listChunks(documentId: string): Promise<DataChunk[]> {
    return this.#chunksByDocument.get(documentId) ?? [];
  }

  async listChunksNeedingEmbedding(limit: number, datasetId?: string): Promise<DataChunk[]> {
    return this.#allChunks()
      .filter((chunk) => !datasetId || chunk.datasetId === datasetId)
      .filter((chunk) => !this.#embeddingsByChunk.has(chunk.id))
      .slice(0, limit);
  }

  async saveChunkEmbedding(chunkId: string, embedding: number[], model: string): Promise<void> {
    const now = new Date().toISOString();
    this.#embeddingsByChunk.set(chunkId, embedding);

    for (const chunks of this.#chunksByDocument.values()) {
      const chunk = chunks.find((candidate) => candidate.id === chunkId);
      if (chunk) {
        chunk.embeddingModel = model;
        chunk.embeddedAt = now;
        return;
      }
    }
  }

  async searchChunks(input: {
    embedding: number[];
    datasetId?: string;
    limit: number;
  }): Promise<DataSearchResult[]> {
    const results: DataSearchResult[] = [];

    for (const chunk of this.#allChunks()) {
      if (input.datasetId && chunk.datasetId !== input.datasetId) {
        continue;
      }

      const embedding = this.#embeddingsByChunk.get(chunk.id);
      const document = this.#documents.get(chunk.documentId);
      const dataset = this.#datasetById(chunk.datasetId);
      if (!embedding || !document || !dataset) {
        continue;
      }

      results.push({
        chunk,
        document: {
          id: document.id,
          title: document.title,
          sourceType: document.sourceType,
          sourceUri: document.sourceUri,
        },
        dataset: {
          id: dataset.id,
          name: dataset.name,
        },
        distance: cosineDistance(input.embedding, embedding),
      });
    }

    return results
      .sort((a, b) => a.distance - b.distance)
      .slice(0, input.limit);
  }

  #getOrCreateDataset(name: string, now: string): DataDataset {
    const existing = this.#datasetsByName.get(name);
    if (existing) {
      return existing;
    }

    const dataset: DataDataset = {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
    };
    this.#datasetsByName.set(name, dataset);
    return dataset;
  }

  #datasetById(id: string): DataDataset | undefined {
    return [...this.#datasetsByName.values()].find((dataset) => dataset.id === id);
  }

  #allChunks(): DataChunk[] {
    return [...this.#chunksByDocument.values()].flat();
  }
}

export function createChunks(
  datasetId: string,
  documentId: string,
  text: string,
  metadata: Record<string, unknown>,
  now: string,
): DataChunk[] {
  return chunkText(text).map((content, chunkIndex) => ({
    id: crypto.randomUUID(),
    documentId,
    datasetId,
    chunkIndex,
    content,
    tokenEstimate: estimateTokens(content),
    metadata,
    createdAt: now,
  }));
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cosineDistance(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 1;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < size; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 1;
  }

  return 1 - dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
