import {
  normalizeAgentAutoRunRequest,
  type AgentAutoRunRequest,
  type AgentAutoRunResult,
  type AgentRunSnapshot,
} from "@chenkoai/agent-core";
import type { AgentPlanner } from "./agentPlanner.js";
import type { AgentRunStore } from "./agentRunStore.js";
import type { AgentRuntime } from "./agentRuntime.js";

export class AgentAutoRunner {
  readonly #store: AgentRunStore;
  readonly #planner: AgentPlanner;
  readonly #runtime: AgentRuntime;

  constructor(store: AgentRunStore, planner: AgentPlanner, runtime: AgentRuntime) {
    this.#store = store;
    this.#planner = planner;
    this.#runtime = runtime;
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

      if (hasPendingPermission(snapshot)) {
        return { snapshot, cycles, stopReason: "permission_required" };
      }

      const beforeFingerprint = fingerprint(snapshot);
      const advanced = await this.#runtime.advance(runId);
      if (!advanced) {
        return undefined;
      }

      cycles += 1;
      snapshot = advanced;

      if (hasPendingPermission(snapshot)) {
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
}

function canPlan(snapshot: AgentRunSnapshot): boolean {
  return (
    snapshot.run.status === "queued" &&
    snapshot.run.steps.every((step) => step.status === "pending")
  );
}

function hasPendingPermission(snapshot: AgentRunSnapshot): boolean {
  return snapshot.run.steps.some(
    (step) => step.status === "running" && step.details?.includes("permission_required"),
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
