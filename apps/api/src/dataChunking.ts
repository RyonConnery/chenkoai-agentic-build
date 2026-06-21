export function chunkText(text: string, maxCharacters = 1_500): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/).map((paragraph) => paragraph.trim());
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      continue;
    }

    if (paragraph.length > maxCharacters) {
      flushCurrent();
      chunks.push(...splitLongText(paragraph, maxCharacters));
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxCharacters) {
      flushCurrent();
      current = paragraph;
    } else {
      current = candidate;
    }
  }

  flushCurrent();
  return chunks;

  function flushCurrent(): void {
    if (current) {
      chunks.push(current);
      current = "";
    }
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function splitLongText(text: string, maxCharacters: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxCharacters) {
    chunks.push(text.slice(start, start + maxCharacters).trim());
  }

  return chunks.filter(Boolean);
}
