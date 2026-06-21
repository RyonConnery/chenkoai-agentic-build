import { z } from "zod";

export const agentRunRequestSchema = z.object({
  goal: z.string().min(1),
  context: z.string().optional(),
  maxSteps: z.number().int().positive().max(50).default(12),
});

export type AgentRunRequest = z.input<typeof agentRunRequestSchema>;

export type AgentRun = {
  id: string;
  status: "queued";
  goal: string;
  plan: string[];
};

export function createAgentRun(input: AgentRunRequest): AgentRun {
  const request = agentRunRequestSchema.parse(input);

  return {
    id: crypto.randomUUID(),
    status: "queued",
    goal: request.goal,
    plan: [
      "Clarify objective and constraints",
      "Select tools and data sources",
      "Execute the safest next action",
      "Verify output before continuing",
    ],
  };
}

