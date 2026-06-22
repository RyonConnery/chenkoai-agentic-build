import type { AgentRunSnapshot, AgentRunStep, DataSearchResult } from "@chenkoai/agent-core";
import type { DataStore } from "./dataStore.js";
import type { EmbeddingProviderAdapter } from "./embeddingProvider.js";

export class AgentMemoryRetriever {
  readonly #dataStore: DataStore;
  readonly #embeddingProvider: EmbeddingProviderAdapter;
  readonly #limit: number;

  constructor(
    dataStore: DataStore,
    embeddingProvider: EmbeddingProviderAdapter,
    limit = Number(process.env.AGENT_MEMORY_RESULTS ?? 4),
  ) {
    this.#dataStore = dataStore;
    this.#embeddingProvider = embeddingProvider;
    this.#limit = Math.max(0, Math.min(12, limit));
  }

  async retrieve(snapshot: AgentRunSnapshot, step: AgentRunStep): Promise<string> {
    if (this.#limit === 0) {
      return "None";
    }

    const query = createMemoryQuery(snapshot, step);
    return await this.#search(query);
  }

  async retrieveForPlanning(snapshot: AgentRunSnapshot): Promise<string> {
    if (this.#limit === 0) {
      return "None";
    }

    return await this.#search(createPlanningMemoryQuery(snapshot));
  }

  async #search(query: string): Promise<string> {
    const embedding = await this.#embeddingProvider.embed(query);
    const candidates = await this.#dataStore.searchChunks({
      embedding: embedding.embedding,
      embeddingModel: embedding.model,
      limit: Math.min(40, Math.max(this.#limit * 5, 12)),
    });

    const results = rerankMemoryResults(candidates, this.#limit);
    return formatMemoryResults(results);
  }
}

function createPlanningMemoryQuery(snapshot: AgentRunSnapshot): string {
  return [
    snapshot.run.goal,
    snapshot.run.context,
    "ChenkoAI workspace overview current capabilities architecture roadmap data storage tools agent runtime",
  ]
    .filter(Boolean)
    .join("\n");
}

function createMemoryQuery(snapshot: AgentRunSnapshot, step: AgentRunStep): string {
  const completedStepSummaries = snapshot.run.steps
    .filter((candidate) => candidate.status === "completed")
    .map((candidate) => [
      `Completed step ${candidate.index + 1}: ${candidate.title}`,
      summarizeStepOutput(candidate.details),
    ])
    .flat()
    .filter(Boolean);

  return [
    snapshot.run.goal,
    snapshot.run.context,
    `Current step ${step.index + 1}: ${step.title}`,
    `Find memory specifically useful for this step, not only general project overview.`,
    ...completedStepSummaries,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeStepOutput(details: string | undefined): string {
  if (!details) {
    return "";
  }

  const output = details.split("Agent output:").at(1) ?? details;
  return output.replace(/\s+/g, " ").trim().slice(0, 500);
}

function rerankMemoryResults(results: DataSearchResult[], limit: number): DataSearchResult[] {
  const ranked = [...results].sort((left, right) => scoreMemoryResult(right) - scoreMemoryResult(left));
  const selected: DataSearchResult[] = [];
  const seenSources = new Set<string>();

  for (const result of ranked) {
    const source = memorySourceKey(result);
    if (seenSources.has(source)) {
      continue;
    }

    selected.push(result);
    seenSources.add(source);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected.length > 0 ? selected : ranked.slice(0, limit);
}

function scoreMemoryResult(result: DataSearchResult): number {
  const source = memorySourceKey(result);
  const title = result.document.title.toLowerCase();
  const metadata = result.chunk.metadata as { kind?: unknown };
  let score = 1 - result.distance;

  if (metadata.kind === "workspace-overview" || source === "chenkoai://workspace-overview") {
    score += 1.4;
  }
  if (source === "readme.md" || title === "readme.md") {
    score += 1.0;
  }
  if (source.startsWith("docs/")) {
    score += 1.0;
  }
  if (source.includes("agent") || source.includes("tool") || source.includes("memory")) {
    score += 0.5;
  }
  if (source.endsWith("cargo.toml") || source.endsWith("package.json")) {
    score -= 0.6;
  }

  return score;
}

function memorySourceKey(result: DataSearchResult): string {
  return (result.document.sourceUri ?? result.document.title).replace(/\\/g, "/").toLowerCase();
}

function formatMemoryResults(results: DataSearchResult[]): string {
  if (results.length === 0) {
    return "None";
  }

  return results
    .map((result, index) =>
      [
        `[${index + 1}] ${result.document.title} (${result.dataset.name}, distance ${result.distance.toFixed(4)})`,
        result.chunk.content,
      ].join("\n"),
    )
    .join("\n\n");
}
