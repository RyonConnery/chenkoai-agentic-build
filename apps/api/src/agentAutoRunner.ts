import {
  normalizeAgentAutoRunRequest,
  type AgentAutoRunRequest,
  type AgentAutoRunResult,
  type AgentRunSnapshot,
  type ToolPermissionRequest,
} from "@chenkoai/agent-core";
import type { AgentPlanner } from "./agentPlanner.js";
import type { AgentRunStore } from "./agentRunStore.js";
import type { AgentRuntime } from "./agentRuntime.js";
import type { ToolPermissionStore } from "./toolPermissions.js";

export class AgentAutoRunner {
  readonly #store: AgentRunStore;
  readonly #planner: AgentPlanner;
  readonly #runtime: AgentRuntime;
  readonly #permissions: ToolPermissionStore;

  constructor(
    store: AgentRunStore,
    planner: AgentPlanner,
    runtime: AgentRuntime,
    permissions: ToolPermissionStore,
  ) {
    this.#store = store;
    this.#planner = planner;
    this.#runtime = runtime;
    this.#permissions = permissions;
  }

  async run(runId: string, input: AgentAutoRunRequest): Promise<AgentAutoRunResult | undefined> {
    const request = normalizeAgentAutoRunRequest(input ?? {});
    let snapshot = await this.#store.getSnapshot(runId);
    if (!snapshot) {
      return undefined;
    }

    if (request.planFirst && canPlan(snapshot)) {
      snapshot = (await this.#planner.plan(runId)) ?? snapshot;
    }

    let cycles = 0;
    while (cycles < request.maxCycles) {
      if (snapshot.run.status === "completed") {
        return { snapshot, cycles, stopReason: "completed" };
      }

      const permissionStatus = await this.#resolveBlockedPermission(snapshot);
      if (permissionStatus.approved) {
        const executed = await this.#runtime.executeApprovedPermission(
          runId,
          permissionStatus.approved,
        );
        if (!executed) {
          return undefined;
        }

        cycles += 1;
        snapshot = executed;
        continue;
      }

      if (permissionStatus.pending) {
        return { snapshot, cycles, stopReason: "permission_required" };
      }

      const beforeFingerprint = fingerprint(snapshot);
      const advanced = await this.#runtime.advance(runId);
      if (!advanced) {
        return undefined;
      }

      cycles += 1;
      snapshot = advanced;

      const nextPermissionStatus = await this.#resolveBlockedPermission(snapshot);
      if (nextPermissionStatus.approved) {
        continue;
      }

      if (nextPermissionStatus.pending) {
        return { snapshot, cycles, stopReason: "permission_required" };
      }

      if (snapshot.run.status === "completed") {
        return { snapshot, cycles, stopReason: "completed" };
      }

      if (fingerprint(snapshot) === beforeFingerprint) {
        return { snapshot, cycles, stopReason: "no_progress" };
      }
    }

    return { snapshot, cycles, stopReason: "max_cycles_reached" };
  }

  async #resolveBlockedPermission(snapshot: AgentRunSnapshot): Promise<{
    pending?: ToolPermissionRequest;
    approved?: ToolPermissionRequest;
  }> {
    const ids = extractPermissionIds(snapshot);
    if (ids.size === 0) {
      return {};
    }

    const permissions = await this.#permissions.list();
    const referencedPermissions = permissions.filter((permission) => ids.has(permission.id));

    return {
      approved: referencedPermissions.find((permission) => permission.status === "approved"),
      pending: referencedPermissions.find((permission) => permission.status === "pending"),
    };
  }
}

function canPlan(snapshot: AgentRunSnapshot): boolean {
  return (
    snapshot.run.status === "queued" &&
    snapshot.run.steps.every((step) => step.status === "pending")
  );
}

function fingerprint(snapshot: AgentRunSnapshot): string {
  return JSON.stringify({
    status: snapshot.run.status,
    updatedAt: snapshot.run.updatedAt,
    steps: snapshot.run.steps.map((step) => ({
      id: step.id,
      status: step.status,
      details: step.details,
    })),
  });
}

function extractPermissionIds(snapshot: AgentRunSnapshot): Set<string> {
  const ids = new Set<string>();
  const pattern = /Permission request:\s+([0-9a-fA-F-]{36})/g;

  for (const step of snapshot.run.steps) {
    for (const match of step.details?.matchAll(pattern) ?? []) {
      const id = match[1];
      if (id) {
        ids.add(id);
      }
    }
  }

  return ids;
}
