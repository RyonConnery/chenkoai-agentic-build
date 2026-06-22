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

const overviewFileCandidates = [
  "README.md",
  "docs\\architecture.md",
  "docs\\roadmap.md",
  "docs\\data-ingestion.md",
  "docs\\desktop-control-center.md",
  "docs\\model-provider.md",
  "package.json",
  "Cargo.toml",
  "infra\\docker-compose.yml",
];

const systemDatasetName = "chenkoai-system-scan";

export type SystemScanResult = {
  datasetName: string;
  workspaceRoot: string;
  mode: "append" | "replace";
  scannedFiles: number;
  ingestedDocuments: number;
  skippedFiles: number;
  embeddedChunks: number;
  replacedDocuments: number;
  replacedChunks: number;
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
      datasetName: systemDatasetName,
    };
  }

  async scan(
    input: { maxFiles?: number; maxFileBytes?: number; mode?: "append" | "replace" } = {},
  ): Promise<SystemScanResult> {
    const mode = input.mode === "replace" ? "replace" : "append";
    const maxFiles = clamp(input.maxFiles ?? 1_500, 1, 2_500);
    const maxFileBytes = clamp(input.maxFileBytes ?? 120_000, 1_000, 1_000_000);
    const files = (await this.#collectFiles(".", Math.min(maxFiles * 4, 10_000)))
      .sort(compareFilePriority)
      .slice(0, maxFiles);
    let ingestedDocuments = 0;
    let skippedFiles = 0;
    const replaced =
      mode === "replace"
        ? await this.#dataStore.deleteDatasetByName(systemDatasetName)
        : { documentCount: 0, chunkCount: 0 };

    const overview = await this.#createWorkspaceOverview();
    if (overview) {
      await this.#dataStore.ingestText({
        datasetName: systemDatasetName,
        title: "ChenkoAI Workspace Overview",
        sourceType: "manual",
        sourceUri: "chenkoai://workspace-overview",
        text: overview,
        metadata: {
          generated: true,
          kind: "workspace-overview",
          scannedAt: new Date().toISOString(),
        },
      });
      ingestedDocuments += 1;
    }

    for (const file of files) {
      const absolutePath = path.join(this.#workspaceRoot, file);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size > maxFileBytes) {
        skippedFiles += 1;
        continue;
      }

      const text = await fs.readFile(absolutePath, "utf8");
      await this.#dataStore.ingestText({
        datasetName: systemDatasetName,
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
    const datasetId = datasets.find((dataset) => dataset.name === systemDatasetName)?.id;
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
      datasetName: systemDatasetName,
      workspaceRoot: this.#workspaceRoot,
      mode,
      scannedFiles: files.length,
      ingestedDocuments,
      skippedFiles,
      embeddedChunks,
      replacedDocuments: replaced.documentCount,
      replacedChunks: replaced.chunkCount,
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

  async #createWorkspaceOverview(): Promise<string> {
    const sections: string[] = [];

    for (const file of overviewFileCandidates) {
      const normalized = path.normalize(file);
      const absolutePath = path.join(this.#workspaceRoot, normalized);

      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile() || stat.size > 80_000) {
          continue;
        }

        const text = await fs.readFile(absolutePath, "utf8");
        sections.push([`## ${normalized}`, text.slice(0, 6_000).trim()].join("\n\n"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }

        throw error;
      }
    }

    if (sections.length === 0) {
      return "";
    }

    return [
      "# ChenkoAI Workspace Overview",
      "This generated memory document summarizes high-signal project files for workspace-level questions.",
      currentCapabilitySummary(),
      ...sections,
    ].join("\n\n");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function compareFilePriority(left: string, right: string): number {
  return filePriority(right) - filePriority(left) || left.localeCompare(right);
}

function filePriority(file: string): number {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  let score = 0;

  if (normalized === "readme.md") {
    score += 1_000;
  }
  if (normalized.startsWith("docs/")) {
    score += 800;
  }
  if (normalized.endsWith("package.json") || normalized.endsWith("cargo.toml")) {
    score += 500;
  }
  if (normalized.startsWith("apps/api/") || normalized.startsWith("packages/agent-core/")) {
    score += 350;
  }
  if (normalized.startsWith("apps/desktop/")) {
    score += 250;
  }
  if (normalized.startsWith("infra/") || normalized.startsWith("scripts/")) {
    score += 200;
  }
  if (normalized.includes(".example") || normalized.endsWith(".env")) {
    score -= 200;
  }

  return score;
}

function currentCapabilitySummary(): string {
  return [
    "## Current Implemented Capabilities",
    "- Desktop control center built with Tauri and React.",
    "- Hidden local TypeScript API launched by the desktop shell.",
    "- Local Ollama model provider support through `local-http`.",
    "- Local embedding provider support through `nomic-embed-text`.",
    "- PostgreSQL durable storage for datasets, documents, chunks, agent runs, prompt templates, and tool permission requests.",
    "- pgvector-backed semantic chunk search.",
    "- Workspace scanner that ingests source, docs, config, scripts, and generated workspace overview memory.",
    "- Persistent Ask Memory workflow that retrieves stored chunks and answers with local model output plus source chunks.",
    "- Agent run lifecycle with planning, auto-run, progress reports, and run events.",
    "- Prompt registry with version activation.",
    "- Local tool permission queue for safe workspace tools.",
  ].join("\n");
}
