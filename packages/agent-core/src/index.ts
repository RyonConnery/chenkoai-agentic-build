import { z } from "zod";

export const agentRunRequestSchema = z.object({
  goal: z.string().min(1),
  context: z.string().optional(),
  maxSteps: z.number().int().positive().max(50).default(12),
});

export const agentAutoRunRequestSchema = z.object({
  maxCycles: z.number().int().positive().max(25).default(8),
  planFirst: z.boolean().default(true),
});

export const modelProviderSchema = z.enum(["mock", "openai-compatible", "local-http"]);

export const embeddingProviderSchema = z.enum(["mock", "openai-compatible", "local-http"]);

export const modelGenerateRequestSchema = z.object({
  prompt: z.string().min(1),
  systemPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(8192).default(1024),
  provider: modelProviderSchema.optional(),
  model: z.string().optional(),
});

export const promptTemplateMutationSchema = z.object({
  description: z.string().min(1),
  system: z.string().min(1),
  user: z.string().min(1),
  activate: z.boolean().default(true),
});

export const textIngestRequestSchema = z.object({
  datasetName: z.string().min(1).default("default"),
  title: z.string().min(1),
  sourceType: z.enum(["manual", "file", "url", "api"]).default("manual"),
  sourceUri: z.string().optional(),
  text: z.string().min(1),
  metadata: z.record(z.unknown()).default({}),
});

export const embeddingRebuildRequestSchema = z.object({
  datasetId: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const dataSearchRequestSchema = z.object({
  query: z.string().min(1),
  datasetId: z.string().optional(),
  limit: z.number().int().positive().max(50).default(8),
});

export const localToolNameSchema = z.enum([
  "workspace.list_files",
  "workspace.read_text_file",
  "workspace.write_text_file",
  "workspace.run_project_check",
  "workspace.git_status",
  "workspace.git_diff",
  "workspace.detect_development_tools",
  "workspace.open_development_target",
  "workspace.run_dev_task",
  "workspace.ingest_selected_content",
]);

export const toolExecuteRequestSchema = z.object({
  name: localToolNameSchema,
  input: z.record(z.unknown()).default({}),
  approvalId: z.string().optional(),
});

export const toolPermissionDecisionSchema = z.object({
  approved: z.boolean(),
  decidedBy: z.string().min(1).default("local-user"),
});

export type AgentRunRequest = z.input<typeof agentRunRequestSchema>;
export type NormalizedAgentRunRequest = z.output<typeof agentRunRequestSchema>;
export type AgentAutoRunRequest = z.input<typeof agentAutoRunRequestSchema>;
export type NormalizedAgentAutoRunRequest = z.output<typeof agentAutoRunRequestSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type EmbeddingProvider = z.infer<typeof embeddingProviderSchema>;
export type ModelGenerateRequest = z.input<typeof modelGenerateRequestSchema>;
export type NormalizedModelGenerateRequest = z.output<typeof modelGenerateRequestSchema>;
export type PromptTemplateMutationRequest = z.input<typeof promptTemplateMutationSchema>;
export type NormalizedPromptTemplateMutationRequest = z.output<
  typeof promptTemplateMutationSchema
>;
export type TextIngestRequest = z.input<typeof textIngestRequestSchema>;
export type NormalizedTextIngestRequest = z.output<typeof textIngestRequestSchema>;
export type EmbeddingRebuildRequest = z.input<typeof embeddingRebuildRequestSchema>;
export type NormalizedEmbeddingRebuildRequest = z.output<typeof embeddingRebuildRequestSchema>;
export type DataSearchRequest = z.input<typeof dataSearchRequestSchema>;
export type NormalizedDataSearchRequest = z.output<typeof dataSearchRequestSchema>;
export type LocalToolName = z.infer<typeof localToolNameSchema>;
export type ToolExecuteRequest = z.input<typeof toolExecuteRequestSchema>;
export type NormalizedToolExecuteRequest = z.output<typeof toolExecuteRequestSchema>;
export type ToolPermissionDecisionRequest = z.input<typeof toolPermissionDecisionSchema>;
export type NormalizedToolPermissionDecisionRequest = z.output<
  typeof toolPermissionDecisionSchema
>;

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

export type PromptTemplateVersion = PromptTemplate & {
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type RenderedPrompt = {
  templateId: string;
  version: string;
  systemPrompt: string;
  prompt: string;
};

export type PromptTemplateVariables = Record<string, PromptTemplateVariable>;

export type DataDataset = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

export type DataDocument = {
  id: string;
  datasetId: string;
  title: string;
  sourceType: "manual" | "file" | "url" | "api";
  sourceUri?: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
};

export type DataChunk = {
  id: string;
  documentId: string;
  datasetId: string;
  chunkIndex: number;
  content: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  embeddingModel?: string;
  embeddedAt?: string;
};

export type TextIngestResult = {
  dataset: DataDataset;
  document: DataDocument;
  chunks: DataChunk[];
};

export type DataSearchResult = {
  chunk: DataChunk;
  document: Pick<DataDocument, "id" | "title" | "sourceType" | "sourceUri">;
  dataset: Pick<DataDataset, "id" | "name">;
  distance: number;
};

export type EmbeddingRebuildResult = {
  provider: EmbeddingProvider;
  model: string;
  embeddedChunks: number;
};

export type LocalToolDefinition = {
  name: LocalToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  requiresApproval: boolean;
};

export type ToolPermissionRequest = {
  id: string;
  toolName: LocalToolName;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "used";
  reason: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
};

export type ToolExecutionResult = {
  name: LocalToolName;
  ok: boolean;
  output?: unknown;
  error?: string;
  permissionRequest?: ToolPermissionRequest;
};

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

export type AgentAutoRunResult = {
  snapshot: AgentRunSnapshot;
  cycles: number;
  stopReason:
    | "completed"
    | "permission_required"
    | "max_cycles_reached"
    | "no_progress";
};

export type AgentRunReport = {
  runId: string;
  status: AgentRunStatus;
  goal: string;
  steps: AgentRunStep[];
  progress: {
    totalSteps: number;
    pendingSteps: number;
    runningSteps: number;
    completedSteps: number;
    failedSteps: number;
    percentComplete: number;
  };
  activity: {
    toolExecutions: number;
    permissionRequests: number;
    pendingPermissions: ToolPermissionRequest[];
  };
  nextAction: string;
  generatedAt: string;
};

export function normalizeAgentRunRequest(input: AgentRunRequest): NormalizedAgentRunRequest {
  return agentRunRequestSchema.parse(input);
}

export function normalizeAgentAutoRunRequest(
  input: AgentAutoRunRequest,
): NormalizedAgentAutoRunRequest {
  return agentAutoRunRequestSchema.parse(input);
}

export function normalizeModelGenerateRequest(
  input: ModelGenerateRequest,
): NormalizedModelGenerateRequest {
  return modelGenerateRequestSchema.parse(input);
}

export function normalizePromptTemplateMutationRequest(
  input: PromptTemplateMutationRequest,
): NormalizedPromptTemplateMutationRequest {
  return promptTemplateMutationSchema.parse(input);
}

export function normalizeTextIngestRequest(
  input: TextIngestRequest,
): NormalizedTextIngestRequest {
  return textIngestRequestSchema.parse(input);
}

export function normalizeEmbeddingRebuildRequest(
  input: EmbeddingRebuildRequest,
): NormalizedEmbeddingRebuildRequest {
  return embeddingRebuildRequestSchema.parse(input);
}

export function normalizeDataSearchRequest(input: DataSearchRequest): NormalizedDataSearchRequest {
  return dataSearchRequestSchema.parse(input);
}

export function normalizeToolExecuteRequest(
  input: ToolExecuteRequest,
): NormalizedToolExecuteRequest {
  return toolExecuteRequestSchema.parse(input);
}

export function normalizeToolPermissionDecisionRequest(
  input: ToolPermissionDecisionRequest,
): NormalizedToolPermissionDecisionRequest {
  return toolPermissionDecisionSchema.parse(input);
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
