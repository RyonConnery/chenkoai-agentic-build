import {
  normalizeToolExecuteRequest,
  type ToolExecuteRequest,
} from "@chenkoai/agent-core";

const toolRequestPattern = /```chenkoai-tool\s*([\s\S]*?)```/i;

export function extractToolRequest(text: string): ToolExecuteRequest | undefined {
  const match = text.match(toolRequestPattern);
  const rawJson = match?.[1]?.trim();
  if (!rawJson) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as ToolExecuteRequest;
    return normalizeToolExecuteRequest(parsed);
  } catch {
    return undefined;
  }
}
