import { z } from "zod";

export const agentRunRequestSchema = z.object({
  goal: z.string().min(1),
  context: z.string().optional(),
  maxSteps: z.number().int().positive().max(50).default(12),
});

export type AgentRunRequest = z.input<typeof agentRunRequestSchema>;
export type NormalizedAgentRunRequest = z.output<typeof agentRunRequestSchema>;

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
