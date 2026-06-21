import {
  createInitialAgentRun,
  type AgentRun,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRunSnapshot,
  type AgentRunStatus,
  type AgentRunStep,
  type AgentStepStatus,
} from "@chenkoai/agent-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { AgentRunListItem, AgentRunStore } from "./agentRunStore.js";

type AgentRunRow = QueryResultRow & {
  id: string;
  status: AgentRunStatus;
  goal: string;
  context: string | null;
  max_steps: number;
  plan: string[];
  created_at: Date;
  updated_at: Date;
};

type AgentRunStepRow = QueryResultRow & {
  id: string;
  run_id: string;
  step_index: number;
  title: string;
  status: AgentStepStatus;
  details: string | null;
  started_at: Date | null;
  completed_at: Date | null;
};

type AgentRunEventRow = QueryResultRow & {
  id: string;
  run_id: string;
  type: AgentRunEvent["type"];
  message: string;
  created_at: Date;
};

export class PostgresAgentRunStore implements AgentRunStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(input: AgentRunRequest): Promise<AgentRunSnapshot> {
    const run = createInitialAgentRun(input);
    const createdEvent: AgentRunEvent = {
      id: crypto.randomUUID(),
      runId: run.id,
      type: "created",
      message: `Agent run queued for goal: ${run.goal}`,
      createdAt: run.createdAt,
    };

    await this.#withTransaction(async (client) => {
      await this.#insertRun(client, run);
      await Promise.all(run.steps.map((step) => this.#insertStep(client, run.id, step)));
      await this.#insertEvent(client, createdEvent);
    });

    return this.getSnapshot(run.id).then(requireSnapshot);
  }

  async list(): Promise<AgentRunListItem[]> {
    const result = await this.#pool.query<AgentRunRow>(
      `select id, status, goal, context, max_steps, plan, created_at, updated_at
       from agent_runs
       order by created_at desc`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      goal: row.goal,
      status: row.status,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    }));
  }

  async getSnapshot(id: string): Promise<AgentRunSnapshot | undefined> {
    const runResult = await this.#pool.query<AgentRunRow>(
      `select id, status, goal, context, max_steps, plan, created_at, updated_at
       from agent_runs
       where id = $1`,
      [id],
    );

    const row = runResult.rows[0];
    if (!row) {
      return undefined;
    }

    const [stepsResult, eventsResult] = await Promise.all([
      this.#pool.query<AgentRunStepRow>(
        `select id, run_id, step_index, title, status, details, started_at, completed_at
         from agent_run_steps
         where run_id = $1
         order by step_index asc`,
        [id],
      ),
      this.#pool.query<AgentRunEventRow>(
        `select id, run_id, type, message, created_at
         from agent_run_events
         where run_id = $1
         order by created_at asc`,
        [id],
      ),
    ]);

    return {
      run: mapRun(row, stepsResult.rows),
      events: eventsResult.rows.map(mapEvent),
    };
  }

  async advance(id: string): Promise<AgentRunSnapshot | undefined> {
    return this.#withTransaction(async (client) => {
      const runResult = await client.query<AgentRunRow>(
        `select id, status, goal, context, max_steps, plan, created_at, updated_at
         from agent_runs
         where id = $1
         for update`,
        [id],
      );

      const runRow = runResult.rows[0];
      if (!runRow) {
        return undefined;
      }

      const stepsResult = await client.query<AgentRunStepRow>(
        `select id, run_id, step_index, title, status, details, started_at, completed_at
         from agent_run_steps
         where run_id = $1
         order by step_index asc
         for update`,
        [id],
      );

      const run = mapRun(runRow, stepsResult.rows);
      if (["completed", "failed", "canceled"].includes(run.status)) {
        return this.#getSnapshotWithClient(client, id);
      }

      const now = new Date().toISOString();
      const steps = run.steps.map((step) => ({ ...step }));
      const runningStep = steps.find((step) => step.status === "running");

      if (runningStep) {
        runningStep.status = "completed";
        runningStep.completedAt = now;
        await this.#updateStep(client, runningStep);
        await this.#insertEvent(client, {
          id: crypto.randomUUID(),
          runId: id,
          type: "step_completed",
          message: `Completed step ${runningStep.index + 1}: ${runningStep.title}`,
          createdAt: now,
        });
      }

      const pendingStep = steps.find((step) => step.status === "pending");
      if (pendingStep) {
        pendingStep.status = "running";
        pendingStep.startedAt = now;
        await this.#updateStep(client, pendingStep);
        await this.#insertEvent(client, {
          id: crypto.randomUUID(),
          runId: id,
          type: "step_started",
          message: `Started step ${pendingStep.index + 1}: ${pendingStep.title}`,
          createdAt: now,
        });
      }

      const status: AgentRunStatus = pendingStep ? "running" : "completed";
      if (run.status !== status) {
        await this.#insertEvent(client, {
          id: crypto.randomUUID(),
          runId: id,
          type: "status_changed",
          message: `Run status changed from ${run.status} to ${status}`,
          createdAt: now,
        });
      }

      await client.query(
        `update agent_runs
         set status = $2, updated_at = $3
         where id = $1`,
        [id, status, now],
      );

      return this.#getSnapshotWithClient(client, id);
    });
  }

  async updateStepDetails(
    runId: string,
    stepId: string,
    details: string,
  ): Promise<AgentRunSnapshot | undefined> {
    return this.#withTransaction(async (client) => {
      const now = new Date().toISOString();
      const result = await client.query(
        `update agent_run_steps
         set details = $3
         where run_id = $1 and id = $2`,
        [runId, stepId, details],
      );

      if (result.rowCount === 0) {
        return undefined;
      }

      await client.query(
        `update agent_runs
         set updated_at = $2
         where id = $1`,
        [runId, now],
      );

      return this.#getSnapshotWithClient(client, runId);
    });
  }

  async #getSnapshotWithClient(
    client: PoolClient,
    id: string,
  ): Promise<AgentRunSnapshot | undefined> {
    const runResult = await client.query<AgentRunRow>(
      `select id, status, goal, context, max_steps, plan, created_at, updated_at
       from agent_runs
       where id = $1`,
      [id],
    );

    const row = runResult.rows[0];
    if (!row) {
      return undefined;
    }

    const [stepsResult, eventsResult] = await Promise.all([
      client.query<AgentRunStepRow>(
        `select id, run_id, step_index, title, status, details, started_at, completed_at
         from agent_run_steps
         where run_id = $1
         order by step_index asc`,
        [id],
      ),
      client.query<AgentRunEventRow>(
        `select id, run_id, type, message, created_at
         from agent_run_events
         where run_id = $1
         order by created_at asc`,
        [id],
      ),
    ]);

    return {
      run: mapRun(row, stepsResult.rows),
      events: eventsResult.rows.map(mapEvent),
    };
  }

  async #withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();

    try {
      await client.query("begin");
      const result = await callback(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async #insertRun(client: PoolClient, run: AgentRun): Promise<void> {
    await client.query(
      `insert into agent_runs
       (id, status, goal, context, max_steps, plan, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        run.id,
        run.status,
        run.goal,
        run.context ?? null,
        run.maxSteps,
        run.plan,
        run.createdAt,
        run.updatedAt,
      ],
    );
  }

  async #insertStep(client: PoolClient, runId: string, step: AgentRunStep): Promise<void> {
    await client.query(
      `insert into agent_run_steps
       (id, run_id, step_index, title, status, details, started_at, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        step.id,
        runId,
        step.index,
        step.title,
        step.status,
        step.details ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
      ],
    );
  }

  async #updateStep(client: PoolClient, step: AgentRunStep): Promise<void> {
    await client.query(
      `update agent_run_steps
       set status = $2, details = $3, started_at = $4, completed_at = $5
       where id = $1`,
      [
        step.id,
        step.status,
        step.details ?? null,
        step.startedAt ?? null,
        step.completedAt ?? null,
      ],
    );
  }

  async #insertEvent(client: PoolClient, event: AgentRunEvent): Promise<void> {
    await client.query(
      `insert into agent_run_events
       (id, run_id, type, message, created_at)
       values ($1, $2, $3, $4, $5)`,
      [event.id, event.runId, event.type, event.message, event.createdAt],
    );
  }
}

function mapRun(row: AgentRunRow, steps: AgentRunStepRow[]): AgentRun {
  return {
    id: row.id,
    status: row.status,
    goal: row.goal,
    context: row.context ?? undefined,
    maxSteps: row.max_steps,
    plan: row.plan,
    steps: steps.map(mapStep),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapStep(row: AgentRunStepRow): AgentRunStep {
  return {
    id: row.id,
    index: row.step_index,
    title: row.title,
    status: row.status,
    details: row.details ?? undefined,
    startedAt: row.started_at ? toIso(row.started_at) : undefined,
    completedAt: row.completed_at ? toIso(row.completed_at) : undefined,
  };
}

function mapEvent(row: AgentRunEventRow): AgentRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function requireSnapshot(snapshot: AgentRunSnapshot | undefined): AgentRunSnapshot {
  if (!snapshot) {
    throw new Error("Expected newly-created agent run snapshot to exist");
  }

  return snapshot;
}
