import {
  normalizeToolPermissionDecisionRequest,
  type LocalToolName,
  type ToolPermissionDecisionRequest,
  type ToolPermissionRequest,
} from "@chenkoai/agent-core";

export class ToolPermissionStore {
  readonly #requests = new Map<string, ToolPermissionRequest & { inputKey: string }>();

  create(input: {
    toolName: LocalToolName;
    toolInput: Record<string, unknown>;
    reason: string;
  }): ToolPermissionRequest {
    const now = new Date().toISOString();
    const request: ToolPermissionRequest & { inputKey: string } = {
      id: crypto.randomUUID(),
      toolName: input.toolName,
      input: input.toolInput,
      inputKey: stableStringify(input.toolInput),
      status: "pending",
      reason: input.reason,
      createdAt: now,
    };

    this.#requests.set(request.id, request);
    return toPublicRequest(request);
  }

  list(): ToolPermissionRequest[] {
    return [...this.#requests.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toPublicRequest);
  }

  decide(id: string, input: ToolPermissionDecisionRequest): ToolPermissionRequest | undefined {
    const decision = normalizeToolPermissionDecisionRequest(input);
    const existing = this.#requests.get(id);
    if (!existing) {
      return undefined;
    }

    if (existing.status !== "pending") {
      return toPublicRequest(existing);
    }

    const updated: ToolPermissionRequest & { inputKey: string } = {
      ...existing,
      status: decision.approved ? "approved" : "denied",
      decidedAt: new Date().toISOString(),
      decidedBy: decision.decidedBy,
    };
    this.#requests.set(id, updated);
    return toPublicRequest(updated);
  }

  consumeApproved(input: {
    approvalId: string;
    toolName: LocalToolName;
    toolInput: Record<string, unknown>;
  }): boolean {
    const existing = this.#requests.get(input.approvalId);
    if (!existing || existing.status !== "approved") {
      return false;
    }

    if (existing.toolName !== input.toolName) {
      return false;
    }

    if (existing.inputKey !== stableStringify(input.toolInput)) {
      return false;
    }

    this.#requests.set(existing.id, {
      ...existing,
      status: "used",
    });
    return true;
  }
}

function toPublicRequest(
  request: ToolPermissionRequest & { inputKey: string },
): ToolPermissionRequest {
  const { inputKey: _inputKey, ...publicRequest } = request;
  return publicRequest;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }

  return value;
}
