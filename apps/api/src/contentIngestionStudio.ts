import { promises as fs } from "node:fs";
import path from "node:path";
import type { DataDataset, DataDocument, DataSearchResult } from "@chenkoai/agent-core";
import type { DataDatasetQuality, DataQualitySummary, DataStore } from "./dataStore.js";
import type { EmbeddingProviderAdapter } from "./embeddingProvider.js";

const textFileExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".example",
  ".h",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

const ignoredDirectoryNames = new Set([
  ".git",
  ".next",
  ".tauri",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
  "__pycache__",
]);

export type ContentIngestionSourceKind = "pasted_text" | "workspace_file" | "workspace_folder";

export type ContentIngestionStudioRequest = {
  datasetName: string;
  title: string;
  sourceKind: ContentIngestionSourceKind;
  text?: string;
  path?: string;
  sourceUri?: string;
  evaluationQuery?: string;
  maxFiles?: number;
  maxFileBytes?: number;
};

export type ContentIngestionStudioDocument = Pick<
  DataDocument,
  "id" | "title" | "sourceType" | "sourceUri"
> & {
  chunkCount: number;
};

export type ContentIngestionStudioSkippedSource = {
  source: string;
  reason: string;
};

export type ContentIngestionStudioResult = {
  dataset: DataDataset;
  documents: ContentIngestionStudioDocument[];
  documentCount: number;
  chunkCount: number;
  embeddedChunks: number;
  skippedSources: ContentIngestionStudioSkippedSource[];
  embeddingProvider: string;
  embeddingModel: string;
  evaluationQuery: string;
  retrievalScore: number;
  readyForAgentMemory: boolean;
  readiness: "ready" | "needs_attention";
  results: DataSearchResult[];
  datasetQuality?: DataDatasetQuality;
  quality: DataQualitySummary;
  summary: string;
};

type ContentIngestionStudioDeps = {
  dataStore: DataStore;
  embeddingProvider: EmbeddingProviderAdapter;
  workspaceRoot?: string;
};

type SourceDocument = {
  title: string;
  sourceType: DataDocument["sourceType"];
  sourceUri?: string;
  text: string;
  metadata: Record<string, unknown>;
};

export async function runContentIngestionStudio(
  input: ContentIngestionStudioRequest,
  deps: ContentIngestionStudioDeps,
): Promise<ContentIngestionStudioResult> {
  const workspaceRoot = path.resolve(deps.workspaceRoot ?? process.cwd());
  const request = normalizeRequest(input);
  const sources = await loadSourceDocuments(request, workspaceRoot);
  const documents: ContentIngestionStudioDocument[] = [];
  const skippedSources = [...sources.skippedSources];
  let chunkCount = 0;
  let embeddedChunks = 0;
  let embeddingModel = "";
  let dataset: DataDataset | undefined;

  for (const source of sources.documents) {
    const ingestResult = await deps.dataStore.ingestText({
      datasetName: request.datasetName,
      title: source.title,
      sourceType: source.sourceType,
      sourceUri: source.sourceUri,
      text: source.text,
      metadata: {
        ...source.metadata,
        ingestionMode: "content-ingestion-studio",
        sourceKind: request.sourceKind,
        ingestedAt: new Date().toISOString(),
      },
    });

    dataset = ingestResult.dataset;
    documents.push({
      id: ingestResult.document.id,
      title: ingestResult.document.title,
      sourceType: ingestResult.document.sourceType,
      sourceUri: ingestResult.document.sourceUri,
      chunkCount: ingestResult.chunks.length,
    });
    chunkCount += ingestResult.chunks.length;

    for (const chunk of ingestResult.chunks) {
      const embedding = await deps.embeddingProvider.embed(chunk.content);
      embeddingModel = embedding.model;
      await deps.dataStore.saveChunkEmbedding(chunk.id, embedding.embedding, embedding.model);
      embeddedChunks += 1;
    }
  }

  if (!dataset) {
    throw new Error("No content was available to ingest");
  }

  const evaluationQuery = request.evaluationQuery || request.title;
  const queryEmbedding = await deps.embeddingProvider.embed(evaluationQuery);
  const results = await deps.dataStore.searchChunks({
    embedding: queryEmbedding.embedding,
    embeddingModel: queryEmbedding.model,
    datasetId: dataset.id,
    limit: 6,
  });
  const quality = await deps.dataStore.getQualitySummary();
  const datasetQuality = quality.datasets.find((candidate) => candidate.id === dataset.id);
  const retrievalScore = scoreRetrieval(results);
  const readyForAgentMemory =
    chunkCount > 0 &&
    embeddedChunks === chunkCount &&
    (datasetQuality?.unembeddedChunkCount ?? 0) === 0 &&
    retrievalScore >= 40;
  const readiness = readyForAgentMemory ? "ready" : "needs_attention";

  return {
    dataset,
    documents,
    documentCount: documents.length,
    chunkCount,
    embeddedChunks,
    skippedSources,
    embeddingProvider: deps.embeddingProvider.provider,
    embeddingModel: embeddingModel || queryEmbedding.model,
    evaluationQuery,
    retrievalScore,
    readyForAgentMemory,
    readiness,
    results,
    datasetQuality,
    quality,
    summary: `Content Ingestion Studio stored ${documents.length} document(s), ${chunkCount} chunk(s), and embedded ${embeddedChunks} chunk(s) in ${dataset.name}.`,
  };
}

function normalizeRequest(input: ContentIngestionStudioRequest): Required<
  Pick<ContentIngestionStudioRequest, "datasetName" | "title" | "sourceKind">
> &
  ContentIngestionStudioRequest {
  const datasetName = input.datasetName?.trim();
  const title = input.title?.trim();
  const sourceKind = input.sourceKind;

  if (!datasetName) {
    throw new Error("Dataset name is required");
  }
  if (!title) {
    throw new Error("Title is required");
  }
  if (!["pasted_text", "workspace_file", "workspace_folder"].includes(sourceKind)) {
    throw new Error("Source kind must be pasted_text, workspace_file, or workspace_folder");
  }

  return {
    ...input,
    datasetName,
    title,
    sourceKind,
    text: input.text?.trim(),
    path: input.path?.trim(),
    sourceUri: input.sourceUri?.trim(),
    evaluationQuery: input.evaluationQuery?.trim(),
    maxFiles: clamp(input.maxFiles ?? 25, 1, 100),
    maxFileBytes: clamp(input.maxFileBytes ?? 160_000, 1_000, 1_000_000),
  };
}

async function loadSourceDocuments(
  request: ReturnType<typeof normalizeRequest>,
  workspaceRoot: string,
): Promise<{ documents: SourceDocument[]; skippedSources: ContentIngestionStudioSkippedSource[] }> {
  if (request.sourceKind === "pasted_text") {
    if (!request.text) {
      throw new Error("Pasted text is required");
    }

    return {
      documents: [
        {
          title: request.title,
          sourceType: "manual",
          sourceUri: request.sourceUri || "chenkoai://content-ingestion-studio/pasted-text",
          text: request.text,
          metadata: {
            source: "content-ingestion-studio",
          },
        },
      ],
      skippedSources: [],
    };
  }

  if (!request.path) {
    throw new Error("Workspace path is required");
  }

  if (request.sourceKind === "workspace_file") {
    const absolutePath = resolveWorkspacePath(workspaceRoot, request.path);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw new Error("Workspace path must point to a file");
    }

    return {
      documents: [
        await readSourceFile(workspaceRoot, absolutePath, request.title, request.maxFileBytes),
      ],
      skippedSources: [],
    };
  }

  const folderPath = resolveWorkspacePath(workspaceRoot, request.path);
  const stat = await fs.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error("Workspace path must point to a folder");
  }

  const maxFiles = request.maxFiles ?? 25;
  const maxFileBytes = request.maxFileBytes ?? 160_000;
  const files = await collectFiles(workspaceRoot, folderPath, maxFiles * 4);
  const documents: SourceDocument[] = [];
  const skippedSources: ContentIngestionStudioSkippedSource[] = [];

  for (const file of files.slice(0, maxFiles)) {
    try {
      documents.push(await readSourceFile(workspaceRoot, file, undefined, maxFileBytes));
    } catch (error) {
      skippedSources.push({
        source: path.relative(workspaceRoot, file) || ".",
        reason: error instanceof Error ? error.message : "Unable to read file",
      });
    }
  }

  return { documents, skippedSources };
}

async function readSourceFile(
  workspaceRoot: string,
  absolutePath: string,
  title?: string,
  maxFileBytes = 160_000,
): Promise<SourceDocument> {
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Source is not a file");
  }
  if (stat.size > maxFileBytes) {
    throw new Error(`File is larger than ${maxFileBytes} bytes`);
  }

  const extension = path.extname(absolutePath).toLowerCase();
  if (extension && !textFileExtensions.has(extension)) {
    throw new Error(`Unsupported file type: ${extension}`);
  }
  if (isSensitiveEnvFile(path.basename(absolutePath))) {
    throw new Error("Refusing to ingest sensitive local environment files");
  }

  const relativePath = path.relative(workspaceRoot, absolutePath) || ".";
  const text = await fs.readFile(absolutePath, "utf8");

  return {
    title: title?.trim() || relativePath,
    sourceType: "file",
    sourceUri: relativePath,
    text,
    metadata: {
      source: "content-ingestion-studio",
      relativePath,
      bytes: stat.size,
    },
  };
}

async function collectFiles(
  workspaceRoot: string,
  folderPath: string,
  maxCandidates: number,
): Promise<string[]> {
  const results: string[] = [];
  const queue = [folderPath];

  while (queue.length > 0 && results.length < maxCandidates) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maxCandidates) {
        break;
      }

      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          queue.push(target);
        }
        continue;
      }

      if (
        entry.isFile() &&
        textFileExtensions.has(path.extname(entry.name).toLowerCase()) &&
        !isSensitiveEnvFile(entry.name)
      ) {
        const relative = path.relative(workspaceRoot, target);
        if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
          results.push(target);
        }
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  const trimmed = inputPath.trim();
  const target = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceRoot, trimmed || ".");
  const relative = path.relative(workspaceRoot, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path must stay inside the configured workspace");
  }

  return target;
}

function scoreRetrieval(results: DataSearchResult[]): number {
  const bestDistance = results[0]?.distance;
  if (bestDistance === undefined) {
    return 0;
  }

  return clamp(Math.round((1 - bestDistance) * 100), 0, 100);
}

function isSensitiveEnvFile(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return normalized.startsWith(".env") && !normalized.includes("example");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
