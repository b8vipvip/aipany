import type { AppConfig } from "../config.js";
import {
  getRealtimeExperienceDefinitions,
  isQwen35OmniRealtimeModel,
  isQwenAudioRealtimeModel,
  QWEN_AUDIO_REALTIME_FLASH,
  QWEN_AUDIO_REALTIME_PLUS,
  SUPPORTED_NATIVE_REALTIME_MODELS,
} from "./realtime-experience.js";

export interface ClientVoiceOption {
  id: string;
  name: string;
  gender: "female" | "male" | "neutral";
  description: string;
  previewable?: boolean;
}

export interface ClientExperienceModeOption {
  id: "economy_live" | "native_flash" | "native_plus";
  title: string;
  subtitle: string;
  engine: "cascaded" | "omni_realtime";
  model: string;
  defaultVoice: string;
  voices: ClientVoiceOption[];
}

export interface ClientNativeModelOption {
  id: string;
  name: string;
  family: "qwen_audio" | "qwen35_omni";
}

const QWEN_AUDIO_REALTIME_VOICES: ClientVoiceOption[] = [
  { id: "longanqian", name: "龙安千", gender: "neutral", description: "Qwen-Audio Realtime 默认系统音色", previewable: true },
  { id: "longanlingxin", name: "龙安灵心", gender: "female", description: "知心温暖，适合长期陪伴式对话", previewable: true },
  { id: "longanlingxi", name: "龙安灵希", gender: "female", description: "可爱甜美，表达灵动", previewable: true },
  { id: "longanxiaoxin", name: "龙安小昕", gender: "female", description: "亲切活泼，适合轻松聊天", previewable: true },
  { id: "longanlufeng", name: "龙安鲁风", gender: "neutral", description: "明亮开朗，表达有活力", previewable: true },
];

const QWEN35_OMNI_REALTIME_VOICE_IDS = [
  "Tina", "Cindy", "Liora Mira", "Sunnybobi", "Raymond", "Ethan", "Theo Calm", "Serena",
  "Harvey", "Maia", "Evan", "Qiao", "Momo", "Wil", "Angel", "Li Cassian", "Mia", "Joyner",
  "Gold", "Katerina", "Ryan", "Jennifer", "Aiden", "Mione", "Sunny", "Dylan", "Eric", "Peter",
  "Joseph Chen", "Marcus", "Li", "Kiki", "Rocky", "Sohee", "Lenn", "Ono Anna", "Sonrisa",
  "Bodega", "Emilien", "Andre", "Radio Gol", "Alek", "Rizky", "Roya", "Arda", "Hana", "Dolce",
  "Jakub", "Griet", "Eliška", "Marina", "Siiri", "Ingrid", "Sigga", "Bea", "Chloe",
] as const;

const QWEN35_SPECIAL_VOICE_DESCRIPTIONS: Record<string, string> = {
  Tina: "甜暖自然、陪伴感强",
  Cindy: "轻柔甜美，带台湾口音",
  "Liora Mira": "温柔舒缓，日常陪伴感强",
  Sunnybobi: "开朗自然，邻家感",
  Raymond: "清晰自然的男声",
  Ethan: "阳光温暖、年轻有活力",
  "Theo Calm": "平静治愈、安抚感强",
  Serena: "温柔年轻女声",
  Harvey: "低沉醇厚、成熟耐听",
  Maia: "知性温柔",
  Evan: "年轻亲切的男声",
  Qiao: "甜美可爱、个性鲜明",
  Momo: "俏皮活泼",
  Ryan: "高能量、戏剧表现力强",
  Jennifer: "电影感美式女声",
  Sunny: "四川方言甜美女声",
  Dylan: "北京方言青年男声",
  Eric: "四川方言活力男声",
  Peter: "天津相声风格男声",
  Kiki: "粤语甜美女声",
  Rocky: "粤语幽默男声",
};

const QWEN35_OMNI_REALTIME_VOICES: ClientVoiceOption[] = QWEN35_OMNI_REALTIME_VOICE_IDS.map((id) => ({
  id,
  name: id,
  gender: inferGender(id),
  description: QWEN35_SPECIAL_VOICE_DESCRIPTIONS[id] ?? "Qwen3.5 Omni Realtime 官方系统音色",
  previewable: true,
}));

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
  { id: "Elias", name: "墨讲师", gender: "neutral", description: "清晰理性、适合知识讲解" },
  { id: "Arthur", name: "徐大爷", gender: "male", description: "质朴沉稳、娓娓道来" },
  { id: "Nini", name: "邻家妹妹", gender: "female", description: "软糯亲近、邻家感" },
  { id: "Seren", name: "小婉", gender: "female", description: "温和舒缓、安静陪伴" },
  { id: "Pip", name: "顽屁小孩", gender: "male", description: "调皮童真、活力十足" },
  { id: "Stella", name: "少女阿月", gender: "female", description: "甜美少女、富有表现力" },
];

export function getClientVoiceOptions(model: string, configuredVoice: string): ClientVoiceOption[] {
  if (isQwenAudioRealtimeModel(model)) return QWEN_AUDIO_REALTIME_VOICES.map(cloneVoice);
  if (isQwen35OmniRealtimeModel(model)) return QWEN35_OMNI_REALTIME_VOICES.map(cloneVoice);
  if (model.toLowerCase().includes("qwen3-tts-instruct-flash-realtime")) {
    return ensureConfiguredVoice(QWEN3_INSTRUCT_REALTIME_VOICES, configuredVoice);
  }
  return [{
    id: configuredVoice,
    name: configuredVoice,
    gender: "neutral",
    description: "服务器当前配置音色",
  }];
}

export function getClientExperienceModeOptions(config: AppConfig): ClientExperienceModeOption[] {
  return getRealtimeExperienceDefinitions(config).map((mode) => {
    const configuredVoice = mode.id === "economy_live" ? config.qwen.ttsVoice : defaultVoiceForModel(mode.model);
    const voices = getClientVoiceOptions(mode.model, configuredVoice);
    return {
      ...mode,
      defaultVoice: voices.some((voice) => voice.id === configuredVoice) ? configuredVoice : voices[0]?.id ?? configuredVoice,
      voices,
    };
  });
}

export function getClientNativeModelOptions(): ClientNativeModelOption[] {
  return SUPPORTED_NATIVE_REALTIME_MODELS.map((id) => ({
    id,
    name: id,
    family: isQwenAudioRealtimeModel(id) ? "qwen_audio" : "qwen35_omni",
  }));
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

export function defaultVoiceForModel(model: string): string {
  if (model === QWEN_AUDIO_REALTIME_PLUS || model === QWEN_AUDIO_REALTIME_FLASH) return "longanqian";
  if (isQwen35OmniRealtimeModel(model)) return "Tina";
  return "Cherry";
}

function ensureConfiguredVoice(voices: ClientVoiceOption[], configuredVoice: string): ClientVoiceOption[] {
  if (voices.some((voice) => voice.id === configuredVoice)) return voices.map(cloneVoice);
  return [
    { id: configuredVoice, name: configuredVoice, gender: "neutral", description: "服务器当前配置音色" },
    ...voices.map(cloneVoice),
  ];
}

function cloneVoice(voice: ClientVoiceOption): ClientVoiceOption {
  return { ...voice };
}

function inferGender(id: string): "female" | "male" | "neutral" {
  const male = new Set([
    "Raymond", "Ethan", "Harvey", "Evan", "Wil", "Li Cassian", "Joyner", "Gold", "Ryan", "Aiden",
    "Dylan", "Eric", "Peter", "Joseph Chen", "Marcus", "Li", "Rocky", "Lenn", "Bodega", "Emilien",
    "Andre", "Radio Gol", "Alek", "Rizky", "Arda", "Dolce", "Jakub",
  ]);
  const female = new Set([
    "Tina", "Cindy", "Liora Mira", "Sunnybobi", "Serena", "Maia", "Qiao", "Momo", "Angel", "Mia",
    "Katerina", "Jennifer", "Mione", "Sunny", "Kiki", "Sohee", "Ono Anna", "Sonrisa", "Roya", "Hana",
    "Griet", "Eliška", "Marina", "Siiri", "Ingrid", "Sigga", "Bea", "Chloe",
  ]);
  if (male.has(id)) return "male";
  if (female.has(id)) return "female";
  return "neutral";
}
