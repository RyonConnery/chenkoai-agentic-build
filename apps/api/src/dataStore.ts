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

export type DataDatasetQuality = Pick<DataDataset, "id" | "name" | "updatedAt"> & {
  documentCount: number;
  chunkCount: number;
  embeddedChunkCount: number;
  unembeddedChunkCount: number;
  duplicateDocumentCount: number;
};

export type DataQualitySummary = {
  datasets: DataDatasetQuality[];
  totals: {
    datasetCount: number;
    documentCount: number;
    chunkCount: number;
    embeddedChunkCount: number;
    unembeddedChunkCount: number;
    duplicateDocumentCount: number;
  };
};

export type DataDatasetDeleteResult = {
  deleted: boolean;
  datasetName: string;
  documentCount: number;
  chunkCount: number;
};

export interface DataStore {
  ingestText(input: TextIngestRequest): Promise<TextIngestResult>;
  listDatasets(): Promise<DataDataset[]>;
  listDocuments(datasetId?: string): Promise<DataDocumentListItem[]>;
  getDocument(id: string): Promise<DataDocument | undefined>;
  listChunks(documentId: string): Promise<DataChunk[]>;
  getQualitySummary(): Promise<DataQualitySummary>;
  deleteDatasetByName(datasetName: string): Promise<DataDatasetDeleteResult>;
  listChunksNeedingEmbedding(limit: number, datasetId?: string): Promise<DataChunk[]>;
  saveChunkEmbedding(chunkId: string, embedding: number[], model: string): Promise<void>;
  searchChunks(input: {
    embedding: number[];
    embeddingModel?: string;
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
    const contentHash = hashText(request.text);
    const existing = this.#findExistingDocument(dataset.id, request.sourceUri ?? request.title, contentHash);
    if (existing) {
      return {
        dataset,
        document: existing,
        chunks: this.#chunksByDocument.get(existing.id) ?? [],
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

  async getQualitySummary(): Promise<DataQualitySummary> {
    const datasets = [...this.#datasetsByName.values()].map((dataset) => {
      const documents = [...this.#documents.values()].filter(
        (document) => document.datasetId === dataset.id,
      );
      const chunks = documents.flatMap((document) => this.#chunksByDocument.get(document.id) ?? []);
      const duplicateDocumentCount = countDuplicateDocuments(documents);

      return {
        id: dataset.id,
        name: dataset.name,
        updatedAt: dataset.updatedAt,
        documentCount: documents.length,
        chunkCount: chunks.length,
        embeddedChunkCount: chunks.filter((chunk) => this.#embeddingsByChunk.has(chunk.id)).length,
        unembeddedChunkCount: chunks.filter((chunk) => !this.#embeddingsByChunk.has(chunk.id)).length,
        duplicateDocumentCount,
      };
    });

    return summarizeQuality(datasets);
  }

  async deleteDatasetByName(datasetName: string): Promise<DataDatasetDeleteResult> {
    const dataset = this.#datasetsByName.get(datasetName);
    if (!dataset) {
      return { deleted: false, datasetName, documentCount: 0, chunkCount: 0 };
    }

    const documents = [...this.#documents.values()].filter(
      (document) => document.datasetId === dataset.id,
    );
    const chunkIds = documents.flatMap((document) =>
      (this.#chunksByDocument.get(document.id) ?? []).map((chunk) => chunk.id),
    );

    for (const document of documents) {
      this.#documents.delete(document.id);
      this.#chunksByDocument.delete(document.id);
    }
    for (const chunkId of chunkIds) {
      this.#embeddingsByChunk.delete(chunkId);
    }
    this.#datasetsByName.delete(datasetName);

    return {
      deleted: true,
      datasetName,
      documentCount: documents.length,
      chunkCount: chunkIds.length,
    };
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
    embeddingModel?: string;
    datasetId?: string;
    limit: number;
  }): Promise<DataSearchResult[]> {
    const results: DataSearchResult[] = [];

    for (const chunk of this.#allChunks()) {
      if (input.datasetId && chunk.datasetId !== input.datasetId) {
        continue;
      }
      if (input.embeddingModel && chunk.embeddingModel !== input.embeddingModel) {
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

  #findExistingDocument(
    datasetId: string,
    sourceKey: string,
    contentHash: string,
  ): DataDocument | undefined {
    return [...this.#documents.values()].find(
      (document) =>
        document.datasetId === datasetId &&
        (document.sourceUri ?? document.title) === sourceKey &&
        document.contentHash === contentHash,
    );
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

export function summarizeQuality(datasets: DataDatasetQuality[]): DataQualitySummary {
  return {
    datasets: datasets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    totals: {
      datasetCount: datasets.length,
      documentCount: sumBy(datasets, "documentCount"),
      chunkCount: sumBy(datasets, "chunkCount"),
      embeddedChunkCount: sumBy(datasets, "embeddedChunkCount"),
      unembeddedChunkCount: sumBy(datasets, "unembeddedChunkCount"),
      duplicateDocumentCount: sumBy(datasets, "duplicateDocumentCount"),
    },
  };
}

function countDuplicateDocuments(documents: DataDocument[]): number {
  const counts = new Map<string, number>();
  for (const document of documents) {
    const key = `${document.sourceUri ?? document.title}\u0000${document.contentHash}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function sumBy(
  datasets: DataDatasetQuality[],
  key: keyof Pick<
    DataDatasetQuality,
    "documentCount" | "chunkCount" | "embeddedChunkCount" | "unembeddedChunkCount" | "duplicateDocumentCount"
  >,
): number {
  return datasets.reduce((total, dataset) => total + dataset[key], 0);
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
