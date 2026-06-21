import type { AgentRunSnapshot } from "@chenkoai/agent-core";
import type { AgentRunStore } from "./agentRunStore.js";
import type { ModelProviderAdapter } from "./modelProvider.js";

export class AgentPlanner {
  readonly #store: AgentRunStore;
  readonly #modelProvider: ModelProviderAdapter;

  constructor(store: AgentRunStore, modelProvider: ModelProviderAdapter) {
    this.#store = store;
    this.#modelProvider = modelProvider;
  }

  async plan(runId: string): Promise<AgentRunSnapshot | undefined> {
    const snapshot = await this.#store.getSnapshot(runId);
    if (!snapshot) {
      return undefined;
    }

    const generated = await this.#modelProvider.generate({
      systemPrompt:
        "You are ChenkoAI's planner. Return only a JSON array of concise step titles.",
      prompt: [
        `Goal: ${snapshot.run.goal}`,
        `Context: ${snapshot.run.context ?? "None provided"}`,
        `Maximum steps: ${snapshot.run.maxSteps}`,
        "Create a practical autonomous build plan.",
      ].join("\n"),
      temperature: 0.1,
      maxTokens: 512,
    });

    const plan = sanitizePlan(parsePlan(generated.text), snapshot.run.goal, snapshot.run.maxSteps);
    return await this.#store.replacePlan(runId, plan);
  }
}

function parsePlan(text: string): string[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function sanitizePlan(plan: string[], goal: string, maxSteps: number): string[] {
  const cleaned = plan
    .map((step) => step.trim())
    .filter(Boolean)
    .map((step) => step.slice(0, 160));

  const fallback = [
    `Clarify success criteria for ${goal}`,
    "Inspect relevant project context and constraints",
    "Select the safest memory and tool actions",
    "Execute the next approved build action",
    "Verify results and record follow-up work",
  ];

  return (cleaned.length > 0 ? cleaned : fallback).slice(0, maxSteps);
}
