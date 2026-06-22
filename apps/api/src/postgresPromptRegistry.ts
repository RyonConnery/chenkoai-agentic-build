import { normalizePromptTemplateMutationRequest } from "@chenkoai/agent-core";
import type {
  PromptTemplate,
  PromptTemplateMutationRequest,
  PromptTemplateVariables,
  PromptTemplateVersion,
  RenderedPrompt,
} from "@chenkoai/agent-core";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  defaultPromptTemplates,
  type PromptRegistry,
} from "./promptRegistry.js";

type PromptTemplateRow = QueryResultRow & {
  id: string;
  version: string;
  description: string;
  system: string;
  user_template: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

export class PostgresPromptRegistry implements PromptRegistry {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async seedDefaults(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("begin");
      for (const template of defaultPromptTemplates) {
        await client.query(
          `update prompt_templates
           set active = false, updated_at = now()
           where id = $1 and version <> $2`,
          [template.id, template.version],
        );
        await client.query(
          `insert into prompt_templates
           (id, version, description, system, user_template, active, created_at, updated_at)
           values ($1, $2, $3, $4, $5, true, now(), now())
           on conflict (id, version) do update
           set description = excluded.description,
               system = excluded.system,
               user_template = excluded.user_template,
               active = true,
               updated_at = now()`,
          [
            template.id,
            template.version,
            template.description,
            template.system,
            template.user,
          ],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<PromptTemplate[]> {
    const result = await this.#pool.query<PromptTemplateRow>(
      `select id, version, description, system, user_template
       from prompt_templates
       where active = true
       order by id asc, created_at desc`,
    );

    return result.rows.map(mapPromptTemplateRow);
  }

  async get(id: string): Promise<PromptTemplate | undefined> {
    const result = await this.#pool.query<PromptTemplateRow>(
      `select id, version, description, system, user_template
       from prompt_templates
       where id = $1 and active = true
       order by created_at desc
       limit 1`,
      [id],
    );

    const row = result.rows[0];
    return row ? mapPromptTemplateRow(row) : undefined;
  }

  async listVersions(id: string): Promise<PromptTemplateVersion[]> {
    const result = await this.#pool.query<PromptTemplateRow>(
      `select id, version, description, system, user_template, active, created_at, updated_at
       from prompt_templates
       where id = $1
       order by created_at desc`,
      [id],
    );

    return result.rows.map(mapPromptTemplateVersionRow);
  }

  async upsertVersion(
    id: string,
    version: string,
    input: PromptTemplateMutationRequest,
  ): Promise<PromptTemplateVersion> {
    const request = normalizePromptTemplateMutationRequest(input);

    return this.#withTransaction(async (client) => {
      if (request.activate) {
        await this.#deactivateVersions(client, id);
      }

      const result = await client.query<PromptTemplateRow>(
        `insert into prompt_templates
         (id, version, description, system, user_template, active, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, now(), now())
         on conflict (id, version) do update
         set description = excluded.description,
             system = excluded.system,
             user_template = excluded.user_template,
             active = excluded.active,
             updated_at = now()
         returning id, version, description, system, user_template, active, created_at, updated_at`,
        [
          id,
          version,
          request.description,
          request.system,
          request.user,
          request.activate,
        ],
      );

      return mapPromptTemplateVersionRow(result.rows[0]!);
    });
  }

  async activateVersion(id: string, version: string): Promise<PromptTemplateVersion | undefined> {
    return this.#withTransaction(async (client) => {
      const existing = await client.query<PromptTemplateRow>(
        `select id, version, description, system, user_template, active, created_at, updated_at
         from prompt_templates
         where id = $1 and version = $2`,
        [id, version],
      );

      const row = existing.rows[0];
      if (!row) {
        return undefined;
      }

      await this.#deactivateVersions(client, id);
      const result = await client.query<PromptTemplateRow>(
        `update prompt_templates
         set active = true, updated_at = now()
         where id = $1 and version = $2
         returning id, version, description, system, user_template, active, created_at, updated_at`,
        [id, version],
      );

      return mapPromptTemplateVersionRow(result.rows[0]!);
    });
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

  async #deactivateVersions(client: PoolClient, id: string): Promise<void> {
    await client.query(
      `update prompt_templates
       set active = false, updated_at = now()
       where id = $1`,
      [id],
    );
  }
}

function mapPromptTemplateRow(row: PromptTemplateRow): PromptTemplate {
  return {
    id: row.id,
    version: row.version,
    description: row.description,
    system: row.system,
    user: row.user_template,
  };
}

function mapPromptTemplateVersionRow(row: PromptTemplateRow): PromptTemplateVersion {
  return {
    id: row.id,
    version: row.version,
    description: row.description,
    system: row.system,
    user: row.user_template,
    active: row.active,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
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

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
