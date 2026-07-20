export class StreamingTextChunker {
  private buffer = "";

  constructor(
    private readonly minChars = 8,
    private readonly maxChars = 32,
  ) {}

  push(delta: string): string[] {
    this.buffer += delta;
    const chunks: string[] = [];

    while (this.buffer.length >= this.maxChars) {
      const index = findBestCut(this.buffer, this.minChars, this.maxChars);
      chunks.push(this.take(index));
    }

    const punctuationIndex = findTrailingPunctuationCut(this.buffer, this.minChars);
    if (punctuationIndex > 0) chunks.push(this.take(punctuationIndex));

    return chunks.filter(Boolean);
  }

  flush(): string {
    const text = this.buffer.trim();
    this.buffer = "";
    return text;
  }

  private take(index: number): string {
    const text = this.buffer.slice(0, index).trim();
    this.buffer = this.buffer.slice(index);
    return text;
  }
}

function findBestCut(text: string, minChars: number, maxChars: number): number {
  const candidate = text.slice(0, maxChars);
  for (let i = candidate.length - 1; i >= minChars; i -= 1) {
    if (/[。！？!?；;，,、\n]/u.test(candidate[i - 1] ?? "")) return i;
  }
  return maxChars;
}

function findTrailingPunctuationCut(text: string, minChars: number): number {
  if (text.length < minChars) return -1;
  for (let i = text.length - 1; i >= minChars - 1; i -= 1) {
    if (/[。！？!?；;\n]/u.test(text[i] ?? "")) return i + 1;
  }
  return -1;
}
