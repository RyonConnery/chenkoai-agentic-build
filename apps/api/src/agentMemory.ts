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
    const results = await this.#dataStore.searchChunks({
      embedding: embedding.embedding,
      embeddingModel: embedding.model,
      limit: this.#limit,
    });

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
  return [
    snapshot.run.goal,
    snapshot.run.context,
    step.title,
    ...snapshot.run.steps
      .filter((candidate) => candidate.status === "completed")
      .map((candidate) => candidate.details ?? candidate.title),
  ]
    .filter(Boolean)
    .join("\n");
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
