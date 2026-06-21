import type { AgentRunSnapshot, AgentRunStep } from "@chenkoai/agent-core";
import { extractToolRequest } from "./agentActionProposal.js";
import type { AgentMemoryRetriever } from "./agentMemory.js";
import type { AgentRunStore } from "./agentRunStore.js";
import type { AgentToolExecutor } from "./agentToolExecutor.js";
import type { ModelProviderAdapter } from "./modelProvider.js";
import {
  AGENT_STEP_PROMPT_ID,
  createAgentStepPromptVariables,
  type PromptRegistry,
} from "./promptRegistry.js";

export class AgentRuntime {
  readonly #store: AgentRunStore;
  readonly #modelProvider: ModelProviderAdapter;
  readonly #promptRegistry: PromptRegistry;
  readonly #memoryRetriever?: AgentMemoryRetriever;
  readonly #toolExecutor?: AgentToolExecutor;

  constructor(
    store: AgentRunStore,
    modelProvider: ModelProviderAdapter,
    promptRegistry: PromptRegistry,
    memoryRetriever?: AgentMemoryRetriever,
    toolExecutor?: AgentToolExecutor,
  ) {
    this.#store = store;
    this.#modelProvider = modelProvider;
    this.#promptRegistry = promptRegistry;
    this.#memoryRetriever = memoryRetriever;
    this.#toolExecutor = toolExecutor;
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

    const memoryContext = this.#memoryRetriever
      ? await this.#memoryRetriever.retrieve(advanced, startedStep)
      : "None";
    const prompt = await this.#promptRegistry.render(
      AGENT_STEP_PROMPT_ID,
      {
        ...createAgentStepPromptVariables(advanced, startedStep),
        memoryContext,
      },
    );

    const generated = await this.#modelProvider.generate({
      systemPrompt: prompt.systemPrompt,
      prompt: prompt.prompt,
      temperature: 0.2,
      maxTokens: 512,
    });

    const updated = await this.#store.updateStepDetails(
      advanced.run.id,
      startedStep.id,
      generated.text,
    );

    const toolRequest = extractToolRequest(generated.text);
    if (!toolRequest || !this.#toolExecutor) {
      return updated;
    }

    return (await this.#toolExecutor.execute(advanced.run.id, toolRequest)).snapshot ?? updated;
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
