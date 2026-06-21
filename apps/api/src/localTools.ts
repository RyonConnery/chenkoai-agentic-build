import { promises as fs } from "node:fs";
import path from "node:path";
import {
  normalizeToolExecuteRequest,
  type LocalToolDefinition,
  type ToolExecuteRequest,
  type ToolExecutionResult,
} from "@chenkoai/agent-core";

const defaultWorkspaceRoot = process.cwd();
const textFileExtensions = new Set([
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".env",
  ".example",
  ".h",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yml",
  ".yaml",
]);

export class LocalToolRegistry {
  readonly #workspaceRoot: string;

  constructor(workspaceRoot = process.env.CHENKOAI_WORKSPACE_ROOT ?? defaultWorkspaceRoot) {
    this.#workspaceRoot = path.resolve(workspaceRoot);
  }

  list(): LocalToolDefinition[] {
    return [
      {
        name: "workspace.list_files",
        description: "List files and folders inside the configured ChenkoAI workspace.",
        destructive: false,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative folder path." },
          },
        },
      },
      {
        name: "workspace.read_text_file",
        description: "Read a UTF-8 text file inside the configured ChenkoAI workspace.",
        destructive: false,
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            maxCharacters: {
              type: "number",
              description: "Maximum characters to return. Defaults to 12000.",
            },
          },
        },
      },
    ];
  }

  async execute(input: ToolExecuteRequest): Promise<ToolExecutionResult> {
    const request = normalizeToolExecuteRequest(input);

    try {
      if (request.name === "workspace.list_files") {
        return {
          name: request.name,
          ok: true,
          output: await this.#listFiles(readString(request.input.path, ".")),
        };
      }

      return {
        name: request.name,
        ok: true,
        output: await this.#readTextFile(
          readString(request.input.path),
          readNumber(request.input.maxCharacters, 12_000),
        ),
      };
    } catch (error) {
      return {
        name: request.name,
        ok: false,
        error: error instanceof Error ? error.message : "Tool execution failed",
      };
    }
  }

  async #listFiles(relativePath: string): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const entries = await fs.readdir(target, { withFileTypes: true });

    return {
      workspaceRoot: this.#workspaceRoot,
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      entries: entries
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }))
        .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    };
  }

  async #readTextFile(relativePath: string, maxCharacters: number): Promise<unknown> {
    const target = this.#resolveWorkspacePath(relativePath);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("Target is not a file");
    }

    const extension = path.extname(target).toLowerCase();
    if (extension && !textFileExtensions.has(extension)) {
      throw new Error(`Refusing to read unsupported file type: ${extension}`);
    }

    const content = await fs.readFile(target, "utf8");
    const limit = Math.max(1, Math.min(60_000, maxCharacters));

    return {
      path: toWorkspaceRelativePath(this.#workspaceRoot, target),
      truncated: content.length > limit,
      content: content.slice(0, limit),
    };
  }

  #resolveWorkspacePath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error("Tool paths must be workspace-relative");
    }

    const target = path.resolve(this.#workspaceRoot, relativePath);
    const relative = path.relative(this.#workspaceRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Tool path escapes the configured workspace");
    }

    return target;
  }
}

function readString(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error("Expected a non-empty string input");
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target);
  return relative || ".";
}
