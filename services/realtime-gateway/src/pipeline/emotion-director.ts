import type { UserEmotion } from "@aipany/protocol";

export interface SpeechDirection {
  emotion: string;
  instructions: string;
}

export class EmotionDirector {
  direct(userEmotion: UserEmotion): SpeechDirection {
    switch (userEmotion) {
      case "sad":
        return {
          emotion: "warm_gentle",
          instructions: "用温暖、轻柔、真诚的陪伴语气说话，稍微放慢节奏，停顿自然，不要夸张，不要显得怜悯。",
        };
      case "fearful":
        return {
          emotion: "reassuring",
          instructions: "用稳定、安心、柔和的语气说话，节奏从容，让人有安全感。",
        };
      case "angry":
      case "disgusted":
        return {
          emotion: "calm",
          instructions: "用冷静、克制、尊重的语气说话，不与对方对抗，语速略慢，避免过度兴奋。",
        };
      case "happy":
        return {
          emotion: "cheerful",
          instructions: "用自然开心、轻快、有活力的语气说话，可以带一点笑意，但不要过度表演。",
        };
      case "surprised":
        return {
          emotion: "curious_surprised",
          instructions: "用自然惊喜和好奇的语气说话，开头可以稍有惊讶感，随后恢复流畅自然。",
        };
      case "neutral":
      case "unknown":
      default:
        return {
          emotion: "natural",
          instructions: "用自然、亲切、口语化的中文语气说话，停顿真实，像熟人之间轻松交流，不要播音腔。",
        };
    }
  }
}
