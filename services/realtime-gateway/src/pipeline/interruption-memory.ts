export interface InterruptedTurnSnapshot {
  generatedText: string;
  likelySpokenText?: string;
  reason: "barge_in" | "client_cancel" | "new_turn";
  interruptedAt?: number;
}

/**
 * One-shot memory for a response that was interrupted before completion.
 * It deliberately expires after the next generated turn so it cannot accumulate
 * hidden long-term state or repeatedly bias later answers.
 */
export class InterruptionMemory {
  private pending?: InterruptedTurnSnapshot;

  remember(snapshot: InterruptedTurnSnapshot): void {
    const generatedText = clean(snapshot.generatedText).slice(0, 500);
    const likelySpokenText = clean(snapshot.likelySpokenText ?? "").slice(0, 280);
    if (!generatedText && !likelySpokenText) return;
    this.pending = {
      generatedText,
      likelySpokenText: likelySpokenText || undefined,
      reason: snapshot.reason,
      interruptedAt: snapshot.interruptedAt ?? Date.now(),
    };
  }

  consumeInstruction(): string | undefined {
    const snapshot = this.pending;
    this.pending = undefined;
    if (!snapshot) return undefined;
    const spoken = snapshot.likelySpokenText || snapshot.generatedText.slice(0, 220);
    if (!spoken) return undefined;
    return [
      "上一轮回答被用户打断了。不要从头重复上一轮，也不要解释你被打断。",
      `用户可能已经听到的内容片段：${quote(spoken)}`,
      "优先直接承接用户当前的新要求；如果当前要求指向“第二个、刚才那个、继续、先别说这个”等内容，要结合被打断片段自然续接。",
      "上面的片段只是可能已经播放到的位置，不要逐字复述它。",
    ].join("\n");
  }

  peek(): InterruptedTurnSnapshot | undefined {
    return this.pending ? { ...this.pending } : undefined;
  }

  clear(): void {
    this.pending = undefined;
  }
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quote(text: string): string {
  return `“${text.replace(/[“”]/g, "\"")}”`;
}
