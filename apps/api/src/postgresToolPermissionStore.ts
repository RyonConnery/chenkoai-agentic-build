import {
  normalizeToolPermissionDecisionRequest,
  type LocalToolName,
  type ToolPermissionDecisionRequest,
  type ToolPermissionRequest,
} from "@chenkoai/agent-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { stableStringify, type ToolPermissionStore } from "./toolPermissions.js";

type ToolPermissionRow = QueryResultRow & {
  id: string;
  tool_name: LocalToolName;
  tool_input: Record<string, unknown>;
  input_key: string;
  status: ToolPermissionRequest["status"];
  reason: string;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

export class PostgresToolPermissionStore implements ToolPermissionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(input: {
    toolName: LocalToolName;
    toolInput: Record<string, unknown>;
    reason: string;
  }): Promise<ToolPermissionRequest> {
    const result = await this.#pool.query<ToolPermissionRow>(
      `insert into tool_permission_requests
       (id, tool_name, tool_input, input_key, status, reason, created_at)
       values ($1, $2, $3, $4, 'pending', $5, now())
       returning id, tool_name, tool_input, input_key, status, reason, created_at,
                 decided_at, decided_by`,
      [
        crypto.randomUUID(),
        input.toolName,
        input.toolInput,
        stableStringify(input.toolInput),
        input.reason,
      ],
    );

    return mapRow(result.rows[0]!);
  }

  async list(): Promise<ToolPermissionRequest[]> {
    const result = await this.#pool.query<ToolPermissionRow>(
      `select id, tool_name, tool_input, input_key, status, reason, created_at,
              decided_at, decided_by
       from tool_permission_requests
       order by created_at desc`,
    );

    return result.rows.map(mapRow);
  }

  async decide(
    id: string,
    input: ToolPermissionDecisionRequest,
  ): Promise<ToolPermissionRequest | undefined> {
    const decision = normalizeToolPermissionDecisionRequest(input);

    return this.#withTransaction(async (client) => {
      const existing = await client.query<ToolPermissionRow>(
        `select id, tool_name, tool_input, input_key, status, reason, created_at,
                decided_at, decided_by
         from tool_permission_requests
         where id = $1
         for update`,
        [id],
      );
      const row = existing.rows[0];
      if (!row) {
        return undefined;
      }

      if (row.status !== "pending") {
        return mapRow(row);
      }

      const result = await client.query<ToolPermissionRow>(
        `update tool_permission_requests
         set status = $2, decided_at = now(), decided_by = $3
         where id = $1
         returning id, tool_name, tool_input, input_key, status, reason, created_at,
                   decided_at, decided_by`,
        [id, decision.approved ? "approved" : "denied", decision.decidedBy],
      );

      return mapRow(result.rows[0]!);
    });
  }

  async consumeApproved(input: {
    approvalId: string;
    toolName: LocalToolName;
    toolInput: Record<string, unknown>;
  }): Promise<boolean> {
    return this.#withTransaction(async (client) => {
      const existing = await client.query<ToolPermissionRow>(
        `select id, tool_name, tool_input, input_key, status, reason, created_at,
                decided_at, decided_by
         from tool_permission_requests
         where id = $1
         for update`,
        [input.approvalId],
      );
      const row = existing.rows[0];
      if (!row || row.status !== "approved") {
        return false;
      }

      if (row.tool_name !== input.toolName) {
        return false;
      }

      if (row.input_key !== stableStringify(input.toolInput)) {
        return false;
      }

      await client.query(
        `update tool_permission_requests
         set status = 'used'
         where id = $1`,
        [input.approvalId],
      );

      return true;
    });
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
}

function mapRow(row: ToolPermissionRow): ToolPermissionRequest {
  return {
    id: row.id,
    toolName: row.tool_name,
    input: row.tool_input,
    status: row.status,
    reason: row.reason,
    createdAt: toIso(row.created_at),
    decidedAt: row.decided_at ? toIso(row.decided_at) : undefined,
    decidedBy: row.decided_by ?? undefined,
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
