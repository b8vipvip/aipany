import { providerCategories, providerProtocols } from "@aipany/provider-types";
import { z } from "zod";
export const providerInputSchema=z.object({name:z.string().min(1),category:z.enum(providerCategories),protocol:z.enum(providerProtocols),enabled:z.boolean().default(true),baseUrl:z.string().url(),model:z.string().min(1),voice:z.string().optional().nullable(),apiKey:z.string().optional().nullable(),priority:z.number().int().default(100),settings:z.record(z.unknown()).default({})});
export const providerUpdateSchema=providerInputSchema.partial().extend({apiKey:z.string().optional().nullable()});
export const policySchema=z.object({realtimeProviderId:z.string().uuid().nullable().optional(),textProviderId:z.string().uuid().nullable().optional(),asrProviderId:z.string().uuid().nullable().optional(),ttsProviderId:z.string().uuid().nullable().optional()});
