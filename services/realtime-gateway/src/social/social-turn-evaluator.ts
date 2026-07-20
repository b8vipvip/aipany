import type { EnvironmentContext } from "@aipany/audio-intelligence";

export interface SocialTurnSignals {
  addressedToAssistant: boolean;
  explicitWakeWord: boolean;
  directQuestionToAssistant: boolean;
  helpfulnessScore: number;
  urgencyScore: number;
  noveltyScore: number;
}

export function evaluateSocialTurn(input: {
  text: string;
  assistantAliases: string[];
  recentHumanTurns: string[];
  environment?: EnvironmentContext;
}): SocialTurnSignals {
  const text = normalize(input.text);
  const aliases = input.assistantAliases.map(normalize).filter(Boolean);
  const explicitWakeWord = aliases.some((alias) => text.includes(alias));

  const assistantDirectedPatterns = [
    "你觉得",
    "你认为",
    "你知道",
    "你能",
    "你可以",
    "你帮",
    "帮我",
    "告诉我",
    "怎么看",
    "有什么建议",
    "有没有办法",
    "你说",
    "问你",
  ];
  const addressedToAssistant = explicitWakeWord || assistantDirectedPatterns.some((pattern) => text.includes(pattern));
  const questionCue = /[?？]$/.test(text) || /^(为什么|怎么|怎样|什么|哪|谁|多少|能不能|可不可以|是不是|要不要)/.test(text);
  const directQuestionToAssistant = addressedToAssistant && questionCue;

  const helpfulnessKeywords = [
    "建议", "怎么办", "怎么", "为什么", "路线", "时间", "天气", "交通", "查一下", "搜索", "比较", "选择",
    "计划", "安排", "提醒", "翻译", "计算", "解释", "推荐", "注意事项", "风险", "施工", "航班", "酒店",
  ];
  const helpfulnessHits = helpfulnessKeywords.filter((keyword) => text.includes(keyword)).length;
  let helpfulnessScore = clamp(0.18 + helpfulnessHits * 0.18 + (questionCue ? 0.18 : 0), 0, 1);
  if (addressedToAssistant) helpfulnessScore = Math.max(helpfulnessScore, 0.72);

  const urgentKeywords = [
    "危险", "救命", "着火", "火灾", "报警", "急救", "紧急", "快点", "马上", "小心", "注意", "撞", "事故", "中毒",
  ];
  let urgencyScore = clamp(urgentKeywords.filter((keyword) => text.includes(keyword)).length * 0.35, 0, 1);
  urgencyScore = Math.max(urgencyScore, environmentUrgency(input.environment));

  const noveltyScore = calculateNovelty(text, input.recentHumanTurns);
  return {
    addressedToAssistant,
    explicitWakeWord,
    directQuestionToAssistant,
    helpfulnessScore,
    urgencyScore,
    noveltyScore,
  };
}

export function buildEnvironmentInstruction(environment: EnvironmentContext | undefined): string | undefined {
  if (!environment) return undefined;
  const meaningfulEvents = environment.events
    .filter((event) => event.confidence >= 0.45)
    .slice(0, 4)
    .map((event) => `${event.type}(${event.confidence.toFixed(2)})`);
  if (!environment.scene && meaningfulEvents.length === 0) return undefined;
  return [
    environment.scene ? `当前环境场景=${environment.scene}` : undefined,
    environment.noiseLevel ? `噪声等级=${environment.noiseLevel}` : undefined,
    meaningfulEvents.length ? `检测到的环境事件=${meaningfulEvents.join("、")}` : undefined,
    "环境识别是概率信号，不要把低置信度事件当成确定事实；只有涉及安全风险时才主动提醒。",
  ].filter(Boolean).join("；");
}

function environmentUrgency(environment: EnvironmentContext | undefined): number {
  if (!environment) return 0;
  const urgentLabels = ["siren", "alarm", "smoke", "fire", "explosion", "gunshot", "horn", "crash", "scream"];
  let score = 0;
  for (const event of environment.events) {
    const label = event.type.toLowerCase();
    if (urgentLabels.some((keyword) => label.includes(keyword))) score = Math.max(score, event.confidence);
  }
  return score;
}

function calculateNovelty(text: string, recentTurns: string[]): number {
  if (!text || recentTurns.length === 0) return 1;
  const current = bigrams(text);
  let maximumSimilarity = 0;
  for (const turn of recentTurns.slice(-6)) {
    const previous = bigrams(normalize(turn));
    maximumSimilarity = Math.max(maximumSimilarity, jaccard(current, previous));
  }
  return clamp(1 - maximumSimilarity, 0, 1);
}

function bigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 2) return new Set(compact ? [compact] : []);
  const output = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) output.add(compact.slice(index, index + 2));
  return output;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
