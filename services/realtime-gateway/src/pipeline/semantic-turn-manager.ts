export type TurnCompletion = "complete" | "likely_complete" | "incomplete" | "uncertain";

export interface SemanticTurnDecision {
  completion: TurnCompletion;
  commitDelayMs: number;
  reason: string;
}

/**
 * Lightweight semantic endpoint policy for the Economy path.
 * It runs locally and intentionally uses conservative linguistic signals instead
 * of another model call. The client endpoint detector still detects silence; this
 * class decides whether that silence likely means "finished" or "thinking".
 */
export class SemanticTurnManager {
  decide(text: string): SemanticTurnDecision {
    const value = text.trim();
    const compact = value.replace(/\s+/g, "");
    if (!compact) return decision("uncertain", 260, "empty_partial");

    if (isStrongCompletion(compact)) return decision("complete", 40, "terminal_completion");
    if (isShortAcknowledgement(compact)) return decision("complete", 20, "short_acknowledgement");
    if (hasUnclosedStructure(compact)) return decision("incomplete", 720, "unclosed_structure");
    if (endsWithContinuation(compact)) return decision("incomplete", 680, "continuation_tail");
    if (endsWithSoftPause(compact)) return decision("incomplete", 560, "soft_pause_tail");
    if (looksLikeQuestion(compact)) return decision("likely_complete", 100, "question_shape");
    if (compact.length <= 5) return decision("uncertain", 360, "very_short_turn");
    if (compact.length >= 26) return decision("likely_complete", 140, "long_semantic_unit");
    return decision("uncertain", 260, "neutral_pause");
  }
}

function isStrongCompletion(text: string): boolean {
  return /[。！？!?；;]$/u.test(text)
    || /(?:就这样|没别的了|说完了|先这样|差不多了|就这些)$/u.test(text);
}

function looksLikeQuestion(text: string): boolean {
  return /(?:吗|呢|么|嘛|怎么办|为什么|怎么回事|可以不|行不行|对不对)$/u.test(text)
    || /^(?:为什么|怎么|如何|能不能|可不可以|是不是|有没有|哪里|谁|什么|多少|几|哪)/u.test(text);
}

function endsWithContinuation(text: string): boolean {
  return /(?:然后|但是|可是|不过|因为|所以|而且|另外|还有|包括|比如|例如|就是说|就是|其实|我觉得|我想说|问题是|关键是|如果|虽然|只要|除非|至于|关于|结果|后来|接着|然后呢)$/u.test(text);
}

function endsWithSoftPause(text: string): boolean {
  return /(?:[,，、:：…]|\.\.\.|……)$/u.test(text)
    || /(?:嗯|呃|额|那个|这个|怎么说|让我想想|我想想)$/u.test(text);
}

function hasUnclosedStructure(text: string): boolean {
  const pairs: Array<[string, string]> = [["（", "）"], ["(", ")"], ["“", "”"], ["\"", "\""]];
  for (const [open, close] of pairs) {
    const openCount = count(text, open);
    const closeCount = open === close ? openCount % 2 : count(text, close);
    if (open === close ? closeCount === 1 : openCount > closeCount) return true;
  }
  return false;
}

function isShortAcknowledgement(text: string): boolean {
  return text.length <= 10 && /^(?:嗯+|哦+|噢+|好+|好的|行|可以|对+|是的|知道了|明白了|没错|确实)$/u.test(text);
}

function count(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function decision(completion: TurnCompletion, commitDelayMs: number, reason: string): SemanticTurnDecision {
  return { completion, commitDelayMs, reason };
}
