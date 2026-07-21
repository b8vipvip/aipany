export class StreamingTextChunker {
  private buffer = "";
  private emittedFirstChunk = false;

  constructor(
    private readonly minChars = 8,
    private readonly maxChars = 32,
    private readonly firstChunkMinChars = 4,
    private readonly firstChunkMaxChars = 18,
  ) {}

  push(delta: string): string[] {
    this.buffer += delta;
    const chunks: string[] = [];

    if (!this.emittedFirstChunk) {
      const firstCut = findFirstChunkCut(this.buffer, this.firstChunkMinChars, this.firstChunkMaxChars);
      if (firstCut > 0) {
        chunks.push(this.take(firstCut));
        this.emittedFirstChunk = true;
      }
    }

    while (this.buffer.length >= this.maxChars) {
      const index = findBestCut(this.buffer, this.minChars, this.maxChars);
      chunks.push(this.take(index));
      this.emittedFirstChunk = true;
    }

    const punctuationIndex = findTrailingPunctuationCut(this.buffer, this.minChars);
    if (punctuationIndex > 0) {
      chunks.push(this.take(punctuationIndex));
      this.emittedFirstChunk = true;
    }

    return chunks.filter(Boolean);
  }

  flush(): string {
    const text = this.buffer.trim();
    this.buffer = "";
    if (text) this.emittedFirstChunk = true;
    return text;
  }

  private take(index: number): string {
    const text = this.buffer.slice(0, index).trim();
    this.buffer = this.buffer.slice(index);
    return text;
  }
}

function findFirstChunkCut(text: string, minChars: number, maxChars: number): number {
  if (text.length < minChars) return -1;
  const candidate = text.slice(0, maxChars);
  for (let i = candidate.length; i >= minChars; i -= 1) {
    if (/[。！？!?；;，,、：:\n]/u.test(candidate[i - 1] ?? "")) return i;
  }
  return text.length >= maxChars ? maxChars : -1;
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
