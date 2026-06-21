import { createHash } from "node:crypto";
import {
  normalizeTextIngestRequest,
  type DataChunk,
  type DataDataset,
  type DataDocument,
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
}

export class InMemoryDataStore implements DataStore {
  readonly #datasetsByName = new Map<string, DataDataset>();
  readonly #documents = new Map<string, DataDocument>();
  readonly #chunksByDocument = new Map<string, DataChunk[]>();

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
