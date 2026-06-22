import type { AgentRunSnapshot, AgentRunStep } from "@chenkoai/agent-core";
import { extractToolRequest, stripToolRequestBlocks } from "./agentActionProposal.js";
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
      formatStepDetails(memoryContext, generated.text),
    );

    const toolRequest = extractToolRequest(generated.text);
    if (!toolRequest || !this.#toolExecutor) {
      return updated;
    }

    return (await this.#toolExecutor.execute(advanced.run.id, toolRequest)).snapshot ?? updated;
  }
}

function formatStepDetails(memoryContext: string, generatedText: string): string {
  const memorySummary = summarizeMemoryContext(memoryContext);
  const displayText = stripToolRequestBlocks(generatedText);
  return [
    memorySummary ? ["Memory used:", memorySummary].join("\n") : undefined,
    ["Agent output:", displayText || "Tool action proposed for approval."].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function summarizeMemoryContext(memoryContext: string): string {
  if (memoryContext === "None") {
    return "";
  }

  return memoryContext
    .split(/\n\n+/)
    .map((entry) => {
      const [source, ...body] = entry.split(/\r?\n/);
      const snippet = body.join(" ").replace(/\s+/g, " ").trim().slice(0, 180);
      return [source?.trim(), snippet].filter(Boolean).join(" - ");
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 4)
    .join("\n");
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
