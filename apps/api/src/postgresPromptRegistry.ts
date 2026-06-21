import type {
  PromptTemplate,
  PromptTemplateVariables,
  RenderedPrompt,
} from "@chenkoai/agent-core";
import type { Pool, QueryResultRow } from "pg";
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
};

export class PostgresPromptRegistry implements PromptRegistry {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async seedDefaults(): Promise<void> {
    await Promise.all(
      defaultPromptTemplates.map((template) =>
        this.#pool.query(
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
        ),
      ),
    );
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

