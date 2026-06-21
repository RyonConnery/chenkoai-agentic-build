import type { AgentRunSnapshot, AgentRunStep } from "@chenkoai/agent-core";
import type { AgentRunStore } from "./agentRunStore.js";
import type { ModelProviderAdapter } from "./modelProvider.js";

export class AgentRuntime {
  readonly #store: AgentRunStore;
  readonly #modelProvider: ModelProviderAdapter;

  constructor(store: AgentRunStore, modelProvider: ModelProviderAdapter) {
    this.#store = store;
    this.#modelProvider = modelProvider;
  }

  async advance(runId: string): Promise<AgentRunSnapshot | undefined> {
    const before = await this.#store.getSnapshot(runId);
    const advanced = await this.#store.advance(runId);
    if (!advanced) {
      return undefined;
    }

    const startedStep = findNewlyStartedStep(before, advanced);
    if (!startedStep || startedStep.details) {
      return advanced;
    }

    const generated = await this.#modelProvider.generate({
      systemPrompt:
        "You are ChenkoAI, an autonomous software-building agent. Produce concise, actionable output for the active run step.",
      prompt: buildStepPrompt(advanced, startedStep),
      temperature: 0.2,
      maxTokens: 512,
    });

    return await this.#store.updateStepDetails(
      advanced.run.id,
      startedStep.id,
      generated.text,
    );
  }
}

function findNewlyStartedStep(
  before: AgentRunSnapshot | undefined,
  after: AgentRunSnapshot,
): AgentRunStep | undefined {
  const beforeSteps = new Map(before?.run.steps.map((step) => [step.id, step.status]) ?? []);

  return after.run.steps.find(
    (step) => step.status === "running" && beforeSteps.get(step.id) !== "running",
  );
}

function buildStepPrompt(snapshot: AgentRunSnapshot, step: AgentRunStep): string {
  const completedSteps = snapshot.run.steps
    .filter((candidate) => candidate.status === "completed")
    .map((candidate) => `- ${candidate.title}${candidate.details ? `: ${candidate.details}` : ""}`)
    .join("\n");

  return [
    `Goal: ${snapshot.run.goal}`,
    snapshot.run.context ? `Context: ${snapshot.run.context}` : undefined,
    completedSteps ? `Completed steps:\n${completedSteps}` : "Completed steps: none",
    `Current step ${step.index + 1}: ${step.title}`,
    "Return the concrete work output for this step. Keep it direct and useful.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
