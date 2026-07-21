export interface ClientVoiceOption {
  id: string;
  name: string;
  gender: "female" | "male";
  description: string;
}

const QWEN35_OMNI_REALTIME_VOICES: ClientVoiceOption[] = [
  { id: "Tina", name: "甜甜 Tina", gender: "female", description: "甜暖自然、陪伴感强，适合实时对话" },
  { id: "Cindy", name: "林欣宜 Cindy", gender: "female", description: "轻柔甜美，带台湾口音" },
];

const QWEN3_INSTRUCT_REALTIME_VOICES: ClientVoiceOption[] = [
  { id: "Cherry", name: "芊悦", gender: "female", description: "阳光积极、亲切自然" },
  { id: "Serena", name: "苏瑶", gender: "female", description: "温柔自然" },
  { id: "Ethan", name: "晨煦", gender: "male", description: "阳光温暖、充满活力" },
  { id: "Chelsie", name: "千雪", gender: "female", description: "轻快的二次元少女感" },
  { id: "Momo", name: "茉兔", gender: "female", description: "俏皮活泼、撒娇搞怪" },
  { id: "Vivian", name: "十三", gender: "female", description: "可爱又有一点小暴躁" },
  { id: "Moon", name: "月白", gender: "male", description: "率性、清爽、帅气" },
  { id: "Maia", name: "四月", gender: "female", description: "知性与温柔" },
  { id: "Kai", name: "凯", gender: "male", description: "舒缓、放松、耐听" },
  { id: "Nofish", name: "不吃鱼", gender: "male", description: "自然随和的设计师声线" },
  { id: "Bella", name: "萌宝", gender: "female", description: "灵动可爱、活泼俏皮" },
  { id: "Eldric Sage", name: "沧明子", gender: "male", description: "沉稳睿智、沧桑有故事感" },
  { id: "Mia", name: "乖小妹", gender: "female", description: "温顺柔和、乖巧自然" },
  { id: "Mochi", name: "沙小弥", gender: "male", description: "聪明伶俐、童真早慧" },
  { id: "Bellona", name: "燕铮莺", gender: "female", description: "洪亮清晰、感染力强" },
  { id: "Vincent", name: "田叔", gender: "male", description: "沙哑磁性、江湖故事感" },
  { id: "Bunny", name: "萌小姬", gender: "female", description: "软萌甜美" },
  { id: "Neil", name: "阿闻", gender: "male", description: "字正腔圆、专业主持感" },
  { id: "Elias", name: "墨讲师", gender: "female", description: "清晰理性、适合知识讲解" },
  { id: "Arthur", name: "徐大爷", gender: "male", description: "质朴沉稳、娓娓道来" },
  { id: "Nini", name: "邻家妹妹", gender: "female", description: "软糯亲近、邻家感" },
  { id: "Seren", name: "小婉", gender: "female", description: "温和舒缓、安静陪伴" },
  { id: "Pip", name: "顽屁小孩", gender: "male", description: "调皮童真、活力十足" },
  { id: "Stella", name: "少女阿月", gender: "female", description: "甜美少女、富有表现力" },
];

export function getClientVoiceOptions(model: string, configuredVoice: string): ClientVoiceOption[] {
  const normalized = model.toLowerCase();
  if (isQwen35OmniRealtime(normalized)) {
    // Do not expose a stale cascaded-TTS voice as valid for Native Live. The
    // server will safely fall back to the first model-supported voice instead.
    return QWEN35_OMNI_REALTIME_VOICES.map((voice) => ({ ...voice }));
  }
  if (normalized.includes("qwen3-tts-instruct-flash-realtime")) {
    return ensureConfiguredVoice(QWEN3_INSTRUCT_REALTIME_VOICES, configuredVoice);
  }
  return [{
    id: configuredVoice,
    name: configuredVoice,
    gender: "female",
    description: "服务器当前配置音色",
  }];
}

export function resolveRequestedVoice(model: string, configuredVoice: string, requestedVoice?: string): string {
  const allowed = getClientVoiceOptions(model, configuredVoice);
  const safeConfigured = allowed.some((voice) => voice.id === configuredVoice)
    ? configuredVoice
    : allowed[0]?.id ?? configuredVoice;
  const requested = requestedVoice?.trim();
  if (!requested) return safeConfigured;
  return allowed.some((voice) => voice.id === requested) ? requested : safeConfigured;
}

function isQwen35OmniRealtime(normalizedModel: string): boolean {
  return normalizedModel.includes("qwen3.5")
    && normalizedModel.includes("omni")
    && normalizedModel.includes("realtime");
}

function ensureConfiguredVoice(voices: ClientVoiceOption[], configuredVoice: string): ClientVoiceOption[] {
  if (voices.some((voice) => voice.id === configuredVoice)) return voices.map((voice) => ({ ...voice }));
  return [
    { id: configuredVoice, name: configuredVoice, gender: "female", description: "服务器当前配置音色" },
    ...voices.map((voice) => ({ ...voice })),
  ];
}
