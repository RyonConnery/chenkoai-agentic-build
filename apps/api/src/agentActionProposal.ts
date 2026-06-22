import {
  localToolNameSchema,
  normalizeToolExecuteRequest,
  type ToolExecuteRequest,
} from "@chenkoai/agent-core";

const toolRequestPattern = /```(?:chenkoai-tool|json)\s*([\s\S]*?)```/gi;

export function extractToolRequest(text: string): ToolExecuteRequest | undefined {
  for (const match of text.matchAll(toolRequestPattern)) {
    const rawJson = match[1]?.trim();
    if (!rawJson) {
      continue;
    }

    try {
      return normalizeToolExecuteRequest(repairToolRequest(JSON.parse(rawJson)));
    } catch {
      continue;
    }
  }

  return undefined;
}

export function stripToolRequestBlocks(text: string): string {
  return text.replace(toolRequestPattern, "").trim();
}

function repairToolRequest(value: unknown): ToolExecuteRequest {
  if (!isRecord(value)) {
    throw new Error("Tool request must be an object");
  }

  const candidate = value;
  if (
    candidate.name === "chenkoai-tool" &&
    isRecord(candidate.input) &&
    hasPathAndContent(candidate.input)
  ) {
    return {
      name: "workspace.write_text_file",
      input: candidate.input,
    };
  }

  if (typeof candidate.name === "string") {
    const parsed = localToolNameSchema.safeParse(candidate.name);
    if (parsed.success) {
      return {
        name: parsed.data,
        input: isRecord(candidate.input) ? candidate.input : undefined,
        approvalId: typeof candidate.approvalId === "string" ? candidate.approvalId : undefined,
      };
    }
  }

  throw new Error("Tool request name is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasPathAndContent(value: object): boolean {
  return "path" in value && "content" in value;
}
