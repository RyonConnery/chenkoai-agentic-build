import type { AgentRunReport, AgentRunSnapshot, ToolPermissionRequest } from "@chenkoai/agent-core";
import type { AgentRunStore } from "./agentRunStore.js";
import type { ToolPermissionStore } from "./toolPermissions.js";

export class AgentRunReporter {
  readonly #store: AgentRunStore;
  readonly #permissions: ToolPermissionStore;

  constructor(store: AgentRunStore, permissions: ToolPermissionStore) {
    this.#store = store;
    this.#permissions = permissions;
  }

  async report(runId: string): Promise<AgentRunReport | undefined> {
    const snapshot = await this.#store.getSnapshot(runId);
    if (!snapshot) {
      return undefined;
    }

    const permissions = await this.#permissions.list();
    const referencedPermissionIds = extractPermissionIds(snapshot);
    const runPermissions = permissions.filter((permission) =>
      referencedPermissionIds.has(permission.id),
    );
    const progress = createProgress(snapshot);

    return {
      runId: snapshot.run.id,
      status: snapshot.run.status,
      goal: snapshot.run.goal,
      progress,
      activity: {
        toolExecutions: countMatches(snapshot, /Tool execution:/g),
        permissionRequests: referencedPermissionIds.size,
        pendingPermissions: runPermissions.filter((permission) => permission.status === "pending"),
      },
      nextAction: chooseNextAction(snapshot, runPermissions),
      generatedAt: new Date().toISOString(),
    };
  }
}

function createProgress(snapshot: AgentRunSnapshot): AgentRunReport["progress"] {
  const totalSteps = snapshot.run.steps.length;
  const completedSteps = snapshot.run.steps.filter((step) => step.status === "completed").length;
  const pendingSteps = snapshot.run.steps.filter((step) => step.status === "pending").length;
  const runningSteps = snapshot.run.steps.filter((step) => step.status === "running").length;
  const failedSteps = snapshot.run.steps.filter((step) => step.status === "failed").length;

  return {
    totalSteps,
    pendingSteps,
    runningSteps,
    completedSteps,
    failedSteps,
    percentComplete: totalSteps === 0 ? 0 : Math.round((completedSteps / totalSteps) * 100),
  };
}

function chooseNextAction(
  snapshot: AgentRunSnapshot,
  permissions: ToolPermissionRequest[],
): string {
  const pendingPermission = permissions.find((permission) => permission.status === "pending");
  if (pendingPermission) {
    return `Review permission request ${pendingPermission.id} for ${pendingPermission.toolName}.`;
  }

  if (snapshot.run.status === "queued") {
    return "Plan the run or start the autonomous loop.";
  }

  if (snapshot.run.status === "running") {
    return "Continue the run with advance or auto.";
  }

  if (snapshot.run.status === "completed") {
    return "Review the completed transcript and decide the next goal.";
  }

  return `Review run status ${snapshot.run.status}.`;
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

function countMatches(snapshot: AgentRunSnapshot, pattern: RegExp): number {
  return snapshot.run.steps.reduce((count, step) => {
    return count + [...(step.details?.matchAll(pattern) ?? [])].length;
  }, 0);
}
