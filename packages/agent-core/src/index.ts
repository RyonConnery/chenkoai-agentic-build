import { z } from "zod";

export const agentRunRequestSchema = z.object({
  goal: z.string().min(1),
  context: z.string().optional(),
  maxSteps: z.number().int().positive().max(50).default(12),
});

export const modelProviderSchema = z.enum(["mock", "openai-compatible", "local-http"]);

export const modelGenerateRequestSchema = z.object({
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(8192).default(1024),
  provider: modelProviderSchema.optional(),
  model: z.string().optional(),
});

export type AgentRunRequest = z.input<typeof agentRunRequestSchema>;
export type NormalizedAgentRunRequest = z.output<typeof agentRunRequestSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ModelGenerateRequest = z.input<typeof modelGenerateRequestSchema>;
export type NormalizedModelGenerateRequest = z.output<typeof modelGenerateRequestSchema>;

export type ModelGenerateResponse = {
  provider: ModelProvider;
  model: string;
  text: string;
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type PromptTemplateVariable = string | number | boolean | null | undefined;

export type PromptTemplate = {
  id: string;
  version: string;
  description: string;
  system: string;
  user: string;
};

export type RenderedPrompt = {
  templateId: string;
  version: string;
  systemPrompt: string;
  prompt: string;
};

export type PromptTemplateVariables = Record<string, PromptTemplateVariable>;

export const agentRunStatusSchema = z.enum([
  "queued",
  "planning",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
]);

export const agentStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentStepStatus = z.infer<typeof agentStepStatusSchema>;

export type AgentRunStep = {
  id: string;
  index: number;
  title: string;
  status: AgentStepStatus;
  details?: string;
  startedAt?: string;
  completedAt?: string;
};

export type AgentRun = {
  id: string;
  status: AgentRunStatus;
  goal: string;
  context?: string;
  maxSteps: number;
  plan: string[];
  steps: AgentRunStep[];
  createdAt: string;
  updatedAt: string;
};

export type AgentRunEvent = {
  id: string;
  runId: string;
  type: "created" | "status_changed" | "step_started" | "step_completed";
  message: string;
  createdAt: string;
};

export type AgentRunSnapshot = {
  run: AgentRun;
  events: AgentRunEvent[];
};

export function normalizeAgentRunRequest(input: AgentRunRequest): NormalizedAgentRunRequest {
  return agentRunRequestSchema.parse(input);
}

export function normalizeModelGenerateRequest(
  input: ModelGenerateRequest,
): NormalizedModelGenerateRequest {
  return modelGenerateRequestSchema.parse(input);
}

export function createInitialAgentRun(input: AgentRunRequest, now = new Date()): AgentRun {
  const request = normalizeAgentRunRequest(input);
  const timestamp = now.toISOString();
  const plan = createDefaultPlan(request);

  return {
    id: crypto.randomUUID(),
    status: "queued",
    goal: request.goal,
    context: request.context,
    maxSteps: request.maxSteps,
    plan,
    steps: plan.map((title, index) => ({
      id: crypto.randomUUID(),
      index,
      title,
      status: "pending",
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createAgentRun(input: AgentRunRequest): AgentRun {
  return createInitialAgentRun(input);
}

function createDefaultPlan(request: NormalizedAgentRunRequest): string[] {
  const plan = [
    "Clarify objective and constraints",
    "Select tools and data sources",
    "Execute the safest next action",
    "Verify output before continuing",
  ];

  return plan.slice(0, request.maxSteps);
}
