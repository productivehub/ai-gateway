import { z } from "zod";
import type { ContentBlock, BridgeInput } from "@productivehub/ai-bridge";

// Zod optional fields include explicit undefined; JSON cannot contain that value.
// Check the whole schema against the canonical contract with that one relaxation.
type JsonOptional<T> = T extends (infer U)[] ? JsonOptional<U>[]
  : T extends object ? { [K in keyof T]: JsonOptional<T[K]> | ({} extends Pick<T, K> ? undefined : never) }
  : T;

const record = z.record(z.string(), z.unknown());
const extensions = z.record(z.string(), record.optional());
const cacheControl = z.strictObject({ type: z.literal("ephemeral"), ttl: z.enum(["5m", "1h"]).optional() });
const metadata = { cacheControl: cacheControl.optional(), extensions: extensions.optional() };
const probability = z.number().min(0).max(1);
const evaluationMetadata = {
  ...metadata, id: z.string(), probabilities: z.record(z.string(), probability).optional(), confidence: probability.optional(),
};
const source = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("url"), url: z.string().min(1) }),
  z.strictObject({ type: z.literal("base64"), mediaType: z.string().min(1), data: z.string() }),
  z.strictObject({ type: z.literal("file"), id: z.string().min(1) }),
]);

const block: z.ZodType<JsonOptional<ContentBlock>> = z.lazy(() => z.discriminatedUnion("type", [
  z.strictObject({ ...metadata, type: z.literal("boolean"), id: z.string(), value: z.boolean().nullable(), probability: probability.optional() }),
  z.strictObject({ ...evaluationMetadata, type: z.literal("choice"), value: z.string() }),
  z.strictObject({ ...evaluationMetadata, type: z.literal("score"), value: z.number(), legend: z.record(z.string(), z.string()).optional() }),
  z.strictObject({ ...metadata, type: z.literal("text"), text: z.string(), citations: z.array(z.unknown()).optional() }),
  z.strictObject({ ...metadata, type: z.literal("image"), source, detail: z.enum(["auto", "low", "high", "original"]).optional() }),
  z.strictObject({ ...metadata, type: z.literal("document"), source, name: z.string().optional() }),
  z.strictObject({ ...metadata, type: z.literal("audio"), data: z.string(), format: z.enum(["wav", "mp3"]) }),
  z.strictObject({ ...metadata, type: z.literal("thinking"), text: z.string(), signature: z.string().optional() }),
  z.strictObject({ ...metadata, type: z.literal("redacted-thinking"), data: z.string() }),
  z.strictObject({ ...metadata, type: z.literal("refusal"), text: z.string() }),
  z.strictObject({ ...metadata, type: z.literal("tool-call"), id: z.string(), name: z.string(), input: z.unknown(), arguments: z.string().optional() }),
  z.strictObject({ ...metadata, type: z.literal("tool-result"), id: z.string(), content: z.union([z.string(), z.array(block)]), isError: z.boolean().optional() }),
  z.strictObject({ ...metadata, type: z.literal("native"), dialect: z.string().min(1), value: record }),
]));

/** Strict canonical validation; native fields belong under extensions. */
export const bridgeInputSchema = z.strictObject({
  messages: z.array(z.strictObject({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(block)]),
    name: z.string().optional(), extensions: extensions.optional(),
  })).min(1),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().nonnegative().optional(),
  stop: z.array(z.string()).optional(),
  tools: z.array(z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("function"), name: z.string().min(1), description: z.string().optional(), inputSchema: record, strict: z.boolean().optional(), ...metadata }),
    z.strictObject({ type: z.literal("native"), dialect: z.string().min(1), value: record }),
  ])).optional(),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.strictObject({ name: z.string().min(1) })]).optional(),
  parallelToolCalls: z.boolean().optional(),
  reasoning: z.strictObject({
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    mode: z.enum(["adaptive", "enabled", "disabled"]).optional(),
    budgetTokens: z.number().int().nonnegative().optional(),
    display: z.enum(["summarized", "omitted"]).optional(),
  }).optional(),
  responseFormat: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("text") }),
    z.strictObject({ type: z.literal("json") }),
    z.strictObject({ type: z.literal("json-schema"), name: z.string().min(1), schema: record, strict: z.boolean().optional() }),
  ]).optional(),
  ...metadata,
  cacheKey: z.string().optional(), cacheRetention: z.string().optional(),
  seed: z.number().int().optional(), candidates: z.number().int().positive().optional(),
  keepAlive: z.union([z.string(), z.number()]).optional(), runtimeOptions: record.optional(),
}) satisfies z.ZodType<JsonOptional<BridgeInput>>;
