import {
  type AgentRunSnapshot,
  type AgentRunStep,
  type PromptTemplate,
  type PromptTemplateVariables,
  type RenderedPrompt,
} from "@chenkoai/agent-core";

export const AGENT_STEP_PROMPT_ID = "agent.step.output";

export const defaultPromptTemplates: PromptTemplate[] = [
  {
    id: AGENT_STEP_PROMPT_ID,
    version: "2026-06-21.1",
    description: "Generate concrete output for the active agent run step.",
    system:
      "You are ChenkoAI, an autonomous software-building agent. Produce concise, actionable output for the active run step.",
    user: [
      "Goal: {{goal}}",
      "",
      "Context: {{context}}",
      "",
      "Completed steps:",
      "{{completedSteps}}",
      "",
      "Current step {{stepNumber}}: {{stepTitle}}",
      "",
      "Return the concrete work output for this step. Keep it direct and useful.",
    ].join("\n"),
  },
];

export interface PromptRegistry {
  list(): Promise<PromptTemplate[]>;
  get(id: string): Promise<PromptTemplate | undefined>;
  render(id: string, variables: PromptTemplateVariables): Promise<RenderedPrompt>;
}

export class InMemoryPromptRegistry implements PromptRegistry {
  readonly #promptTemplates = new Map<string, PromptTemplate>();

  constructor(templates = defaultPromptTemplates) {
    for (const template of templates) {
      this.#promptTemplates.set(template.id, template);
    }
  }

  async list(): Promise<PromptTemplate[]> {
    return [...this.#promptTemplates.values()];
  }

  async get(id: string): Promise<PromptTemplate | undefined> {
    return this.#promptTemplates.get(id);
  }

  async render(id: string, variables: PromptTemplateVariables): Promise<RenderedPrompt> {
    const template = await this.get(id);
    if (!template) {
      throw new Error(`Prompt template not found: ${id}`);
    }

    return {
      templateId: template.id,
      version: template.version,
      systemPrompt: renderTemplate(template.system, variables),
      prompt: renderTemplate(template.user, variables),
    };
  }
}

export function createAgentStepPromptVariables(
  snapshot: AgentRunSnapshot,
  step: AgentRunStep,
): PromptTemplateVariables {
  const completedSteps = snapshot.run.steps
    .filter((candidate) => candidate.status === "completed")
    .map((candidate) => `- ${candidate.title}${candidate.details ? `: ${candidate.details}` : ""}`)
    .join("\n");

  return {
    goal: snapshot.run.goal,
    context: snapshot.run.context ?? "None provided",
    completedSteps: completedSteps || "None",
    stepNumber: step.index + 1,
    stepTitle: step.title,
  };
}

function renderTemplate(template: string, variables: PromptTemplateVariables): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) =>
    formatTemplateValue(variables[key]),
  );
}

function formatTemplateValue(value: PromptTemplateVariables[string]): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}
