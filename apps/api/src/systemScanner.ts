import { promises as fs } from "node:fs";
import path from "node:path";
import type { DataStore } from "./dataStore.js";
import type { EmbeddingProviderAdapter } from "./embeddingProvider.js";

const textFileExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".env",
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

export type SystemScanResult = {
  datasetName: string;
  workspaceRoot: string;
  scannedFiles: number;
  ingestedDocuments: number;
  skippedFiles: number;
  embeddedChunks: number;
  truncated: boolean;
};

export class SystemScanner {
  readonly #workspaceRoot: string;
  readonly #dataStore: DataStore;
  readonly #embeddingProvider: EmbeddingProviderAdapter;

  constructor(input: {
    dataStore: DataStore;
    embeddingProvider: EmbeddingProviderAdapter;
    workspaceRoot?: string;
  }) {
    this.#workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd());
    this.#dataStore = input.dataStore;
    this.#embeddingProvider = input.embeddingProvider;
  }

  profile(): { workspaceRoot: string; datasetName: string } {
    return {
      workspaceRoot: this.#workspaceRoot,
      datasetName: "chenkoai-system-scan",
    };
  }

  async scan(input: { maxFiles?: number; maxFileBytes?: number } = {}): Promise<SystemScanResult> {
    const maxFiles = clamp(input.maxFiles ?? 80, 1, 500);
    const maxFileBytes = clamp(input.maxFileBytes ?? 120_000, 1_000, 1_000_000);
    const files = await this.#collectFiles(".", maxFiles);
    let ingestedDocuments = 0;
    let skippedFiles = 0;

    for (const file of files) {
      const absolutePath = path.join(this.#workspaceRoot, file);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }

      const text = await fs.readFile(absolutePath, "utf8");
      await this.#dataStore.ingestText({
        datasetName: "chenkoai-system-scan",
        title: file,
        sourceType: "file",
        sourceUri: file,
        text,
        metadata: {
          relativePath: file,
          bytes: stat.size,
          scannedAt: new Date().toISOString(),
        },
      });
      ingestedDocuments += 1;
    }

    const datasets = await this.#dataStore.listDatasets();
    const datasetId = datasets.find((dataset) => dataset.name === "chenkoai-system-scan")?.id;
    let embeddedChunks = 0;

    for (;;) {
      const chunks = await this.#dataStore.listChunksNeedingEmbedding(100, datasetId);
      if (chunks.length === 0) {
        break;
      }

      for (const chunk of chunks) {
        const response = await this.#embeddingProvider.embed(chunk.content);
        await this.#dataStore.saveChunkEmbedding(chunk.id, response.embedding, response.model);
        embeddedChunks += 1;
      }
    }

    return {
      datasetName: "chenkoai-system-scan",
      workspaceRoot: this.#workspaceRoot,
      scannedFiles: files.length,
      ingestedDocuments,
      skippedFiles,
      embeddedChunks,
      truncated: files.length >= maxFiles,
    };
  }

  async #collectFiles(relativeDirectory: string, maxFiles: number): Promise<string[]> {
    const results: string[] = [];
    const queue = [relativeDirectory];

    while (queue.length > 0 && results.length < maxFiles) {
      const directory = queue.shift()!;
      const absoluteDirectory = path.join(this.#workspaceRoot, directory);
      const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });

      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (results.length >= maxFiles) {
          break;
        }

        const relativePath = path.normalize(path.join(directory, entry.name));
        if (entry.isDirectory()) {
          if (!ignoredDirectoryNames.has(entry.name)) {
            queue.push(relativePath);
          }
          continue;
        }

        if (entry.isFile() && textFileExtensions.has(path.extname(entry.name).toLowerCase())) {
          results.push(relativePath);
        }
      }
    }

    return results;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
