import {
  type AgentRunSnapshot,
  type AgentRunStep,
  type PromptTemplate,
  type PromptTemplateMutationRequest,
  type PromptTemplateVariables,
  type PromptTemplateVersion,
  type RenderedPrompt,
  normalizePromptTemplateMutationRequest,
} from "@chenkoai/agent-core";

export const AGENT_STEP_PROMPT_ID = "agent.step.output";

export const defaultPromptTemplates: PromptTemplate[] = [
  {
    id: AGENT_STEP_PROMPT_ID,
    version: "2026-06-24.1",
    description: "Generate concrete output for the active agent run step.",
    system:
      "You are ChenkoAI, an autonomous software-building agent. Use relevant memory when it helps, but current runtime status is the source of truth for active providers and storage. Produce concrete output only for the active run step. Do not repeat previous step outputs. If a workspace tool action is needed, include exactly one fenced chenkoai-tool JSON block.",
    user: [
      "Goal: {{goal}}",
      "",
      "Context: {{context}}",
      "",
      "Relevant memory:",
      "{{memoryContext}}",
      "",
      "Current runtime status:",
      "{{runtimeStatus}}",
      "",
      "Completed steps:",
      "{{completedSteps}}",
      "",
      "Current step {{stepNumber}}: {{stepTitle}}",
      "",
      "Step execution rules:",
      "- Work only on the current step title.",
      "- Use completed steps as history, not as instructions to repeat.",
      "- Produce a different output from earlier steps.",
      "- Mention specific project files, systems, or next actions when memory supports them.",
      "- Ignore low-value dependency/build folders such as node_modules, target, dist, build, .git, and .next unless the user explicitly asks about them.",
      "- If this step is analysis, return findings and decisions.",
      "- If this step requires real file analysis, first propose workspace.list_files or workspace.read_text_file for the most relevant workspace-relative path.",
      "- If this step is verify, validate, check, or confirm, use workspace.read_text_file or summarize existing evidence. Do not propose workspace.write_text_file for verification.",
      "- If this step needs to verify TypeScript or project health, propose workspace.run_project_check with target api, desktop, or all, or workspace.run_dev_task for a named build/check task.",
      "- If this step needs to understand changed files, propose workspace.git_status before workspace.git_diff.",
      "- If this step needs IDE, engine, or development environment awareness, propose workspace.detect_development_tools.",
      "- If this step needs to open VS Code, an engine project, or a workspace file in a development app, propose workspace.open_development_target with app and path.",
      "- If this step needs to store selected user-approved knowledge into ChenkoAI memory, propose workspace.ingest_selected_content with datasetName, title, text, and optional evaluationQuery.",
      "- If this step is implementation planning, return concrete implementation tasks.",
      "- If this step needs a workspace file action, propose one tool request.",
      "- For workspace.write_text_file, input.path and input.content must both be non-empty strings.",
      "",
      "Available tool names: workspace.list_files, workspace.read_text_file, workspace.write_text_file, workspace.run_project_check, workspace.git_status, workspace.git_diff, workspace.detect_development_tools, workspace.open_development_target, workspace.run_dev_task, workspace.ingest_selected_content.",
      "Available tool proposal format: a fenced block that starts exactly with ```chenkoai-tool and contains JSON with name and input fields.",
      "The JSON name field must be one of the available tool names. Never use chenkoai-tool as the JSON name.",
      "Tool paths must be relative to the configured workspace, for example apps/api/src/server.ts or README.md. Never use absolute Windows paths or shell commands.",
      "Example JSON content: {\"name\":\"workspace.write_text_file\",\"input\":{\"path\":\"notes/example.md\",\"content\":\"Text to write.\"}}",
      "Example project check: {\"name\":\"workspace.run_project_check\",\"input\":{\"target\":\"api\"}}",
      "Example Git status: {\"name\":\"workspace.git_status\",\"input\":{}}",
      "Example development detection: {\"name\":\"workspace.detect_development_tools\",\"input\":{}}",
      "Example IDE open: {\"name\":\"workspace.open_development_target\",\"input\":{\"app\":\"vscode\",\"path\":\"apps/api/src/localTools.ts\"}}",
      "Example dev task: {\"name\":\"workspace.run_dev_task\",\"input\":{\"task\":\"desktop_build\"}}",
      "Example selected memory ingestion: {\"name\":\"workspace.ingest_selected_content\",\"input\":{\"datasetName\":\"chenkoai-selected-memory\",\"title\":\"Important Build Knowledge\",\"text\":\"Content to store.\",\"evaluationQuery\":\"What knowledge was added?\"}}",
      "",
      "Only include a tool block when the action is necessary. Permissioned tools will be approved before they run.",
      "",
      "Return the concrete work output for this step using short sections or bullets.",
    ].join("\n"),
  },
];

export interface PromptRegistry {
  list(): Promise<PromptTemplate[]>;
  get(id: string): Promise<PromptTemplate | undefined>;
  listVersions(id: string): Promise<PromptTemplateVersion[]>;
  upsertVersion(
    id: string,
    version: string,
    input: PromptTemplateMutationRequest,
  ): Promise<PromptTemplateVersion>;
  activateVersion(id: string, version: string): Promise<PromptTemplateVersion | undefined>;
  render(id: string, variables: PromptTemplateVariables): Promise<RenderedPrompt>;
}

export class InMemoryPromptRegistry implements PromptRegistry {
  readonly #promptTemplates = new Map<string, PromptTemplateVersion>();

  constructor(templates = defaultPromptTemplates) {
    for (const template of templates) {
      this.#promptTemplates.set(createTemplateKey(template.id, template.version), {
        ...template,
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async list(): Promise<PromptTemplate[]> {
    return [...this.#promptTemplates.values()]
      .filter((template) => template.active)
      .map(toPromptTemplate);
  }

  async get(id: string): Promise<PromptTemplate | undefined> {
    const template = [...this.#promptTemplates.values()].find(
      (candidate) => candidate.id === id && candidate.active,
    );

    return template ? toPromptTemplate(template) : undefined;
  }

  async listVersions(id: string): Promise<PromptTemplateVersion[]> {
    return [...this.#promptTemplates.values()]
      .filter((template) => template.id === id)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async upsertVersion(
    id: string,
    version: string,
    input: PromptTemplateMutationRequest,
  ): Promise<PromptTemplateVersion> {
    const request = normalizePromptTemplateMutationRequest(input);
    const timestamp = new Date().toISOString();

    if (request.activate) {
      this.#deactivateVersions(id);
    }

    const key = createTemplateKey(id, version);
    const existing = this.#promptTemplates.get(key);
    const template: PromptTemplateVersion = {
      id,
      version,
      description: request.description,
      system: request.system,
      user: request.user,
      active: request.activate ? true : existing?.active ?? false,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    this.#promptTemplates.set(key, template);
    return template;
  }

  async activateVersion(id: string, version: string): Promise<PromptTemplateVersion | undefined> {
    const key = createTemplateKey(id, version);
    const existing = this.#promptTemplates.get(key);
    if (!existing) {
      return undefined;
    }

    this.#deactivateVersions(id);
    const template = {
      ...existing,
      active: true,
      updatedAt: new Date().toISOString(),
    };
    this.#promptTemplates.set(key, template);
    return template;
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

  #deactivateVersions(id: string): void {
    for (const [key, template] of this.#promptTemplates.entries()) {
      if (template.id === id) {
        this.#promptTemplates.set(key, {
          ...template,
          active: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
}

export function createAgentStepPromptVariables(
  snapshot: AgentRunSnapshot,
  step: AgentRunStep,
): PromptTemplateVariables {
  const completedSteps = snapshot.run.steps
    .filter((candidate) => candidate.status === "completed")
    .map((candidate) =>
      [
        `- Step ${candidate.index + 1}: ${candidate.title}`,
        summarizeCompletedStep(candidate.details),
      ]
        .filter(Boolean)
        .join(" - "),
    )
    .join("\n");

  return {
    goal: snapshot.run.goal,
    context: snapshot.run.context ?? "None provided",
    completedSteps: completedSteps || "None",
    memoryContext: "None",
    runtimeStatus: "Runtime status unavailable.",
    stepNumber: step.index + 1,
    stepTitle: step.title,
  };
}

function summarizeCompletedStep(details: string | undefined): string {
  if (!details) {
    return "";
  }

  const output = details.split("Agent output:").at(1) ?? details;
  return output.replace(/\s+/g, " ").trim().slice(0, 360);
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

function createTemplateKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function toPromptTemplate(template: PromptTemplateVersion): PromptTemplate {
  return {
    id: template.id,
    version: template.version,
    description: template.description,
    system: template.system,
    user: template.user,
  };
}
