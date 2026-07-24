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
      const firstCut = findSemanticCut(
        this.buffer,
        this.firstChunkMinChars,
        this.firstChunkMaxChars,
        true,
      );
      if (firstCut > 0) {
        chunks.push(this.take(firstCut));
        this.emittedFirstChunk = true;
      }
    }

    while (this.buffer.length >= this.maxChars) {
      let index = findSemanticCut(this.buffer, this.minChars, this.maxChars, false);
      if (index <= 0) index = findSafeFallbackCut(this.buffer, this.minChars, this.maxChars);
      if (index <= 0) {
        // Prefer waiting for a quote/bracket to close rather than sending a
        // broken spoken phrase. A 2x ceiling prevents unbounded buffering when
        // a model never closes the structure.
        if (this.buffer.length < this.maxChars * 2) break;
        index = this.maxChars;
      }
      chunks.push(this.take(index));
      this.emittedFirstChunk = true;
    }

    const punctuationIndex = findTrailingNaturalCut(this.buffer, this.minChars);
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

interface BoundaryCandidate {
  index: number;
  score: number;
}

const SENTENCE_PUNCTUATION = /[。！？!?；;\n]/u;
const CLAUSE_PUNCTUATION = /[，,、：:]/u;
const SEMANTIC_TRANSITION = /^(?:但是|不过|可是|所以|因此|然后|后来|接着|而且|另外|同时|其实|反过来|换句话说|至于|总之|最后|第一|第二|第三|首先|其次|再者)/u;

function findSemanticCut(text: string, minChars: number, maxChars: number, firstChunk: boolean): number {
  if (text.length < minChars) return -1;
  const limit = Math.min(text.length, maxChars);
  const candidates: BoundaryCandidate[] = [];

  for (let index = minChars; index <= limit; index += 1) {
    if (!isSafeBoundary(text, index)) continue;
    const previous = text[index - 1] ?? "";
    const following = text.slice(index);
    let score = 0;

    if (SENTENCE_PUNCTUATION.test(previous)) score = 120;
    else if (CLAUSE_PUNCTUATION.test(previous)) score = 95;
    else if (SEMANTIC_TRANSITION.test(following.trimStart())) score = 82;
    else if (/\s/u.test(previous)) score = 68;

    if (score <= 0) continue;
    // For the very first spoken phrase, shorter natural cuts reduce perceived
    // latency. Later phrases prefer balanced length and fewer tiny fragments.
    const target = firstChunk ? Math.max(minChars, Math.round(maxChars * 0.62)) : Math.round((minChars + maxChars) / 2);
    const distancePenalty = Math.abs(index - target) * (firstChunk ? 1.1 : 0.55);
    const tinyPenalty = index <= minChars + 1 && !SENTENCE_PUNCTUATION.test(previous) ? 18 : 0;
    candidates.push({ index, score: score - distancePenalty - tinyPenalty });
  }

  if (candidates.length > 0) {
    candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    return candidates[0]?.index ?? -1;
  }

  if (text.length >= maxChars) return findSafeFallbackCut(text, minChars, maxChars);
  return -1;
}

function findSafeFallbackCut(text: string, minChars: number, maxChars: number): number {
  const limit = Math.min(text.length, maxChars);
  for (let index = limit; index >= minChars; index -= 1) {
    if (!isSafeBoundary(text, index)) continue;
    // Avoid leaving a closing mark at the beginning of the next audio phrase.
    if (/[”’」』）)】\]}]/u.test(text[index] ?? "")) continue;
    return index;
  }
  return -1;
}

function findTrailingNaturalCut(text: string, minChars: number): number {
  if (text.length < minChars) return -1;
  for (let index = text.length; index >= minChars; index -= 1) {
    const previous = text[index - 1] ?? "";
    if (!SENTENCE_PUNCTUATION.test(previous)) continue;
    if (isSafeBoundary(text, index)) return index;
  }
  return -1;
}

function isSafeBoundary(text: string, index: number): boolean {
  if (index <= 0 || index > text.length) return false;
  const state = scanStructure(text.slice(0, index));
  return state.roundDepth === 0
    && state.squareDepth === 0
    && state.curlyDepth === 0
    && state.chineseQuoteDepth === 0
    && state.singleQuoteDepth === 0
    && state.doubleQuoteDepth === 0;
}

function scanStructure(text: string) {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let chineseQuoteDepth = 0;
  let singleQuoteDepth = 0;
  let doubleQuoteDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "（" || char === "(") roundDepth += 1;
    else if (char === "）" || char === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (char === "【" || char === "[") squareDepth += 1;
    else if (char === "】" || char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "{") curlyDepth += 1;
    else if (char === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    else if (char === "“" || char === "「" || char === "『") chineseQuoteDepth += 1;
    else if (char === "”" || char === "」" || char === "』") chineseQuoteDepth = Math.max(0, chineseQuoteDepth - 1);
    else if (char === "\"" && !isEscaped(text, index)) doubleQuoteDepth = doubleQuoteDepth === 0 ? 1 : 0;
    else if (char === "'" && !isEscaped(text, index) && isLikelyQuote(text, index)) singleQuoteDepth = singleQuoteDepth === 0 ? 1 : 0;
  }

  return { roundDepth, squareDepth, curlyDepth, chineseQuoteDepth, singleQuoteDepth, doubleQuoteDepth };
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isLikelyQuote(text: string, index: number): boolean {
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  // Apostrophes inside Latin words (don't, user's) are not structural quotes.
  return !(/[A-Za-z0-9]/u.test(previous) && /[A-Za-z0-9]/u.test(next));
}
