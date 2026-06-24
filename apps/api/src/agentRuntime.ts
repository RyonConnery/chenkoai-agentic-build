import type { AgentRunSnapshot, AgentRunStep } from "@chenkoai/agent-core";
import { extractToolRequest, stripToolRequestBlocks } from "./agentActionProposal.js";
import type { AgentMemoryRetriever } from "./agentMemory.js";
import type { AgentRunStore } from "./agentRunStore.js";
import type { AgentToolExecutor } from "./agentToolExecutor.js";
import type { ModelProviderAdapter } from "./modelProvider.js";
import type { ToolExecutionResult, ToolPermissionRequest } from "@chenkoai/agent-core";
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
  readonly #runtimeStatusProvider?: () => Promise<string>;

  constructor(
    store: AgentRunStore,
    modelProvider: ModelProviderAdapter,
    promptRegistry: PromptRegistry,
    memoryRetriever?: AgentMemoryRetriever,
    toolExecutor?: AgentToolExecutor,
    runtimeStatusProvider?: () => Promise<string>,
  ) {
    this.#store = store;
    this.#modelProvider = modelProvider;
    this.#promptRegistry = promptRegistry;
    this.#memoryRetriever = memoryRetriever;
    this.#toolExecutor = toolExecutor;
    this.#runtimeStatusProvider = runtimeStatusProvider;
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
    const runtimeStatus = this.#runtimeStatusProvider
      ? await this.#runtimeStatusProvider()
      : "Runtime status unavailable.";
    const prompt = await this.#promptRegistry.render(
      AGENT_STEP_PROMPT_ID,
      {
        ...createAgentStepPromptVariables(advanced, startedStep),
        memoryContext,
        runtimeStatus,
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

    const toolExecution = await this.#toolExecutor.execute(advanced.run.id, toolRequest);
    const toolUpdated = toolExecution.snapshot ?? updated;
    if (!toolExecution.tool.ok || toolExecution.tool.permissionRequest) {
      return toolUpdated;
    }

    return (
      await this.#store.appendStepDetails(
        advanced.run.id,
        startedStep.id,
        await this.#createToolInformedAnalysis({
          snapshot: advanced,
          step: startedStep,
          memoryContext,
          runtimeStatus,
          tool: toolExecution.tool,
        }),
      )
    ) ?? toolUpdated;
  }

  async executeApprovedPermission(
    runId: string,
    permission: ToolPermissionRequest,
  ): Promise<AgentRunSnapshot | undefined> {
    if (!this.#toolExecutor) {
      return await this.#store.getSnapshot(runId);
    }

    const toolExecution = await this.#toolExecutor.executeApprovedPermission(runId, permission);
    return toolExecution.snapshot ?? (await this.#store.getSnapshot(runId));
  }

  async #createToolInformedAnalysis(input: {
    snapshot: AgentRunSnapshot;
    step: AgentRunStep;
    memoryContext: string;
    runtimeStatus: string;
    tool: ToolExecutionResult;
  }): Promise<string> {
    const generated = await this.#modelProvider.generate({
      systemPrompt: [
        "You are ChenkoAI, an autonomous software-building agent.",
        "Analyze the tool result for the active step and produce useful conclusions.",
        "For workspace listings, focus on source, docs, config, services, packages, crates, scripts, and infrastructure.",
        "Treat dependency/build/internal directories as ignored context unless the user specifically asks about them.",
        "Do not name ignored files or folders; mention only ignored counts or reason categories.",
        "Do not recommend investigating ignored entries unless the user explicitly asks about ignored or hidden entries.",
        "Do not include raw code dumps or JSON blocks.",
        "Do not propose another tool request in this response.",
      ].join(" "),
      prompt: [
        `Goal: ${input.snapshot.run.goal}`,
        `Context: ${input.snapshot.run.context ?? "None provided"}`,
        "",
        "Relevant memory:",
        input.memoryContext,
        "",
        "Current runtime status:",
        input.runtimeStatus,
        "",
        `Current step ${input.step.index + 1}: ${input.step.title}`,
        "",
        "Tool result:",
        summarizeToolResultForModel(input.tool),
        "",
        "Return a Tool-informed analysis with short sections: Findings, Evidence, Next Action.",
      ].join("\n"),
      temperature: 0.15,
      maxTokens: 768,
    });

    return ["Tool-informed analysis:", stripToolRequestBlocks(generated.text)].join("\n");
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

function summarizeToolResultForModel(result: ToolExecutionResult): string {
  if (result.name === "workspace.list_files" && isRecord(result.output)) {
    const ignoredEntries = Array.isArray(result.output.ignoredEntries)
      ? result.output.ignoredEntries.filter(isRecord)
      : [];
    return JSON.stringify(
      {
        name: result.name,
        ok: result.ok,
        path: result.output.path,
        summary: result.output.summary,
        relevantEntries: result.output.entries,
        ignoredEntryCount: ignoredEntries.length,
        ignoredReasonCategories: [
          ...new Set(
            ignoredEntries
              .map((entry) => entry.reason)
              .filter((reason): reason is string => typeof reason === "string"),
          ),
        ],
      },
      undefined,
      2,
    ).slice(0, 12_000);
  }

  return JSON.stringify(
    {
      name: result.name,
      ok: result.ok,
      error: result.error,
      output: result.output,
    },
    undefined,
    2,
  ).slice(0, 16_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
