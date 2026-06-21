import {
  createInitialAgentRun,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRunSnapshot,
} from "@chenkoai/agent-core";

export type AgentRunListItem = Pick<
  AgentRun,
  "id" | "goal" | "status" | "createdAt" | "updatedAt"
>;

export interface AgentRunStore {
  create(input: AgentRunRequest): Promise<AgentRunSnapshot>;
  list(): Promise<AgentRunListItem[]>;
  getSnapshot(id: string): Promise<AgentRunSnapshot | undefined>;
  advance(id: string): Promise<AgentRunSnapshot | undefined>;
  updateStepDetails(
    runId: string,
    stepId: string,
    details: string,
  ): Promise<AgentRunSnapshot | undefined>;
}

export class InMemoryAgentRunStore implements AgentRunStore {
  readonly #runs = new Map<string, AgentRun>();
  readonly #events = new Map<string, AgentRunEvent[]>();

  async create(input: AgentRunRequest): Promise<AgentRunSnapshot> {
    const run = createInitialAgentRun(input);
    this.#runs.set(run.id, run);
    this.#events.set(run.id, [
      {
        id: crypto.randomUUID(),
        runId: run.id,
        type: "created",
        message: `Agent run queued for goal: ${run.goal}`,
        createdAt: run.createdAt,
      },
    ]);

    return (await this.getSnapshot(run.id))!;
  }

  async list(): Promise<AgentRunListItem[]> {
    return [...this.#runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, goal, status, createdAt, updatedAt }) => ({
        id,
        goal,
        status,
        createdAt,
        updatedAt,
      }));
  }

  async getSnapshot(id: string): Promise<AgentRunSnapshot | undefined> {
    const run = this.#runs.get(id);
    if (!run) {
      return undefined;
    }

    return {
      run,
      events: this.#events.get(id) ?? [],
    };
  }

  async advance(id: string): Promise<AgentRunSnapshot | undefined> {
    const run = this.#runs.get(id);
    if (!run) {
      return undefined;
    }

    if (["completed", "failed", "canceled"].includes(run.status)) {
      return this.getSnapshot(id);
    }

    const now = new Date().toISOString();
    const steps = run.steps.map((step) => ({ ...step }));
    const runningStep = steps.find((step) => step.status === "running");

    if (runningStep) {
      runningStep.status = "completed";
      runningStep.completedAt = now;
      this.#appendEvent(id, {
        type: "step_completed",
        message: `Completed step ${runningStep.index + 1}: ${runningStep.title}`,
        createdAt: now,
      });
    }

    const pendingStep = steps.find((step) => step.status === "pending");
    if (pendingStep) {
      pendingStep.status = "running";
      pendingStep.startedAt = now;
      this.#appendEvent(id, {
        type: "step_started",
        message: `Started step ${pendingStep.index + 1}: ${pendingStep.title}`,
        createdAt: now,
      });
    }

    const status = pendingStep ? "running" : "completed";
    if (run.status !== status) {
      this.#appendEvent(id, {
        type: "status_changed",
        message: `Run status changed from ${run.status} to ${status}`,
        createdAt: now,
      });
    }

    this.#runs.set(id, {
      ...run,
      status,
      steps,
      updatedAt: now,
    });

    return this.getSnapshot(id);
  }

  async updateStepDetails(
    runId: string,
    stepId: string,
    details: string,
  ): Promise<AgentRunSnapshot | undefined> {
    const run = this.#runs.get(runId);
    if (!run) {
      return undefined;
    }

    const now = new Date().toISOString();
    const steps = run.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            details,
          }
        : { ...step },
    );

    this.#runs.set(runId, {
      ...run,
      steps,
      updatedAt: now,
    });

    return this.getSnapshot(runId);
  }

  #appendEvent(
    runId: string,
    event: Omit<AgentRunEvent, "id" | "runId">,
  ): void {
    const events = this.#events.get(runId) ?? [];
    events.push({
      id: crypto.randomUUID(),
      runId,
      ...event,
    });
    this.#events.set(runId, events);
  }
}
