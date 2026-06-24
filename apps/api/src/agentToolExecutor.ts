import type {
  AgentRunSnapshot,
  AgentRunStep,
  ToolPermissionRequest,
  ToolExecuteRequest,
  ToolExecutionResult,
} from "@chenkoai/agent-core";
import type { AgentRunStore } from "./agentRunStore.js";
import type { LocalToolRegistry } from "./localTools.js";

export type AgentToolExecutionResponse = {
  tool: ToolExecutionResult;
  snapshot?: AgentRunSnapshot;
};

export class AgentToolExecutor {
  readonly #store: AgentRunStore;
  readonly #tools: LocalToolRegistry;

  constructor(store: AgentRunStore, tools: LocalToolRegistry) {
    this.#store = store;
    this.#tools = tools;
  }

  async execute(runId: string, input: ToolExecuteRequest): Promise<AgentToolExecutionResponse> {
    const snapshot = await this.#store.getSnapshot(runId);
    if (!snapshot) {
      throw requestError(404, "agent_run_not_found", "Agent run not found");
    }

    const activeStep = findActiveStep(snapshot);
    if (!activeStep) {
      throw requestError(409, "agent_run_has_no_active_step", "Agent run has no active step");
    }

    const result = await this.#tools.execute(input);
    const updated = await this.#store.appendStepDetails(
      snapshot.run.id,
      activeStep.id,
      formatToolTranscript(result),
    );

    return {
      tool: result,
      snapshot: updated,
    };
  }

  async executeApprovedPermission(
    runId: string,
    permission: ToolPermissionRequest,
  ): Promise<AgentToolExecutionResponse> {
    const snapshot = await this.#store.getSnapshot(runId);
    if (!snapshot) {
      throw requestError(404, "agent_run_not_found", "Agent run not found");
    }

    if (!isPermissionReferencedByRun(snapshot, permission.id)) {
      throw requestError(
        409,
        "permission_not_referenced_by_run",
        "Permission request does not belong to this agent run",
      );
    }

    if (permission.status !== "approved") {
      throw requestError(
        409,
        "permission_not_approved",
        `Permission request is ${permission.status}`,
      );
    }

    return await this.execute(runId, {
      name: permission.toolName,
      input: permission.input,
      approvalId: permission.id,
    });
  }
}

function findActiveStep(snapshot: AgentRunSnapshot): AgentRunStep | undefined {
  return snapshot.run.steps.find((step) => step.status === "running");
}

function formatToolTranscript(result: ToolExecutionResult): string {
  const summary = summarizeToolOutput(result.output);
  return [
    "Tool execution:",
    `- Tool: ${result.name}`,
    `- Status: ${result.ok ? "ok" : "blocked_or_failed"}`,
    result.permissionRequest
      ? `- Permission request: ${result.permissionRequest.id} (${result.permissionRequest.status})`
      : undefined,
    result.error ? `- Error: ${result.error}` : undefined,
    summary ? `- Output: ${summary}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function isPermissionReferencedByRun(snapshot: AgentRunSnapshot, permissionId: string): boolean {
  return snapshot.run.steps.some((step) =>
    step.details?.includes(`Permission request: ${permissionId}`),
  );
}

function summarizeToolOutput(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return value ? String(value) : undefined;
  }

  const output = value as {
    path?: unknown;
    entries?: unknown;
    ignoredEntries?: unknown;
    summary?: unknown;
    truncated?: unknown;
    content?: unknown;
    bytesWritten?: unknown;
    unchanged?: unknown;
  };

  if (typeof output.summary === "string") {
    return output.summary;
  }

  if (Array.isArray(output.entries)) {
    const ignored = Array.isArray(output.ignoredEntries) ? output.ignoredEntries.length : 0;
    return `Listed ${output.entries.length} relevant entries in ${String(output.path ?? ".")}${ignored > 0 ? ` and ignored ${ignored} low-value or sensitive entries` : ""}.`;
  }

  if (typeof output.content === "string") {
    return `Read ${String(output.path ?? "workspace file")} (${output.content.length} characters${output.truncated ? ", truncated" : ""}).`;
  }

  if (typeof output.bytesWritten === "number") {
    if (output.unchanged === true) {
      return `Verified ${String(output.path ?? "workspace file")} already had the approved content; no write was needed.`;
    }

    return `Wrote ${output.bytesWritten} bytes to ${String(output.path ?? "workspace file")}.`;
  }

  return JSON.stringify(value).slice(0, 500);
}

function requestError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}
