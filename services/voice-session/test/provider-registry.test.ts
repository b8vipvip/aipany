import { describe, expect, it } from "vitest";import { ProviderRegistry } from "../src/provider-registry.js";
describe("ProviderRegistry",()=>{it("没有数据库策略时使用环境变量 fallback",async()=>{const p=await new ProviderRegistry({fallback:{apiKey:"sk-test",baseUrl:"https://api.openai.com/v1",model:"m",voice:"v"}}).getRealtimeProvider();expect(p.name).toBe("openai")})});
