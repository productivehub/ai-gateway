import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createBridge, createBuiltInProviders, resolveBuiltInProviderConfig, JevProvider, jevDialect,
  OpenAIProvider, BridgeError, UnsupportedFeatureError, openaiDialect,
  type BridgeInput, type JevInput, type JevOutput, type EvaluationAnswer,
} from "../src/index.js";
import { baselineResponse } from "./fixtures.js";

const input: JevInput = { state: { message: "My payouts have failed for three days", records: [1, true, null] }, questions: {
  urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: "Time sensitive", false: "Routine" } },
  department: { type: "choice", instructions: { question: "Which team?" }, criteria: { billing: "Payments", technical: null } },
  frustration: { type: "score", instructions: "How frustrated?", criteria: ["Calm", "Angry"] },
} };
const output: JevOutput = { model: "jev-1.13.0", answers: {
  urgent: { type: "noul", noul: 0.95 },
  department: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
  frustration: { type: "score", score: 0.8, legend: { "0": "Calm", "1": "Angry" }, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.6 },
}, usage: { input_tokens: 318, output_tokens: 34, future_usage: true }, request_id: "future-field" };
const answers = {
  urgent: { type: "boolean", value: null, probability: 0.95 },
  department: { type: "choice", value: "billing", probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.8 },
  frustration: { type: "score", value: 0.8, legend: { "0": "Calm", "1": "Angry" }, probabilities: { "0": 0.2, "1": 0.8 }, confidence: 0.6 },
} satisfies Record<string, EvaluationAnswer>;

function http(body: unknown = output, status = 200) {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, calls };
}
afterEach(() => vi.unstubAllEnvs());

describe("Jev provider and dialect", () => {
  it("supports caller-defined answer keys and typed structured or raw responses", async () => {
    interface Questions { urgent: { type: "noul"; instructions: string } }
    const typedInput: JevInput<Questions> = {
      state: "Payment failed", questions: { urgent: { type: "noul", instructions: "Is it urgent?" } },
    };
    expect(jevDialect.toBaseline(typedInput).extensions?.jev?.questions).toEqual(typedInput.questions);
    type NativeAnswers = {
      urgent: { type: "noul"; noul: number };
      department: Extract<import("../src/index.js").JevAnswer, { type: "choice" }>;
      frustration: Extract<import("../src/index.js").JevAnswer, { type: "score" }>;
    };
    type Answers = typeof answers;
    const net = http();
    const bridge = createBridge({ providers: { decisions: new JevProvider({ apiKey: "key", fetch: net.fetch }) }, dialects: { jev: jevDialect } });
    const request = { provider: "decisions" as const, model: "jev-latest", dialect: "jev" as const, input };
    const structured = await bridge.complete<Answers, JevOutput<NativeAnswers>>({ ...request, outputDialect: "structured" });
    expectTypeOf(structured.output).toEqualTypeOf<Answers>();
    expectTypeOf(structured.raw.answers).toEqualTypeOf<NativeAnswers>();
    expect(structured.output).toEqual(answers);
    const raw = await bridge.complete<JevOutput<NativeAnswers>>({ ...request, response: "raw" });
    expectTypeOf(raw.answers).toEqualTypeOf<NativeAnswers>();
    expect(raw).toEqual(output);
  });
  it("sends structured state and all primitives unchanged, preserving typed answers, usage and native metadata", async () => {
    const net = http();
    const bridge = createBridge({ providers: { decisions: new JevProvider({ apiKey: "key", fetch: net.fetch }) }, dialects: { jev: jevDialect, openai: openaiDialect } });
    const response = await bridge.complete({ provider: "decisions", model: "jev-latest", dialect: "jev", input });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(net.calls[0]!.headers.get("authorization")).toBe("Bearer key");
    expect(await net.calls[0]!.json()).toEqual({ ...input, model: "jev-latest" });
    expect(response.model).toBe("jev-latest");
    expect(response.output.model).toBe("jev-1.13.0");
    expect(response.output.choices[0]!.message.content).toMatchObject(Object.entries(answers).map(([id, answer]) => ({ id, ...answer })));
    expect(response.output).not.toHaveProperty("structured");
    expect(response.usage).toMatchObject({ inputTokens: 318, outputTokens: 34, totalTokens: 352 });
    expect(response.raw).toEqual(output);
    expect(response.toDialect("jev")).toEqual(output);
    expect(JSON.parse(response.toDialect("openai").choices[0]!.message.content!)).toEqual(answers);
  });

  it("projects generic evaluation blocks to Jev without provider-specific extensions", () => {
    const canonical = baselineResponse();
    canonical.choices[0]!.message.content = Object.entries(answers).map(([id, answer]) => ({ id, ...answer }));
    expect(jevDialect.fromBaseline(canonical).answers).toEqual(output.answers);
    canonical.choices[0]!.message.content = [{ type: "boolean", id: "approved", value: true }];
    expect(jevDialect.fromBaseline(canonical).answers).toEqual({ approved: { type: "noul", noul: 1 } });
  });

  it.each(["text state", ["first", { text: "second" }], { text: "record" }])("sends state format %# without flattening structured data", async (state) => {
    const native = { ...input, state };
    const net = http();
    await new JevProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "jev-latest", input: jevDialect.toBaseline(native) });
    expect(await net.calls[0]!.json()).toEqual({ ...native, model: "jev-latest" });
  });

  it("uses canonical text messages with native questions", async () => {
    const net = http();
    await new JevProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "custom-jev-version", input: {
      messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }], extensions: { jev: { questions: input.questions } },
    } });
    expect(await net.calls[0]!.json()).toEqual({ state: "onetwo", questions: input.questions, model: "custom-jev-version" });
  });

  it("discovers native aliases without inventing pricing or context limits", async () => {
    const raw = { models: [{ name: "jev-latest", description: "Stable alias", release_date: "2026-04-01", future: true }] };
    const net = http(raw);
    const provider = new JevProvider({ apiKey: "key", baseURL: "https://proxy.test/v1/", fetch: net.fetch });
    expect(await provider.listModels()).toEqual({ models: [{ id: "jev-latest", name: "jev-latest", createdAt: "2026-04-01", raw: raw.models[0] }], raw });
    expect(net.calls[0]!.url).toBe("https://proxy.test/v1/models");
    expect(net.calls[0]!.method).toBe("GET");
  });

  it("registers only configured connections and captures TypeSafe settings at construction", async () => {
    expect(createBuiltInProviders({}, {})).toEqual({});
    expect(createBuiltInProviders({ jev: { apiKey: " " } }, { TYPESAFE_API_KEY: "ambient" })).toEqual({});
    expect(resolveBuiltInProviderConfig({}, { TYPESAFE_API_KEY: "key", TYPESAFE_BASE_URL: "https://proxy.test/v1" })).toEqual({ jev: { apiKey: "key", baseURL: "https://proxy.test/v1" } });
    expect(createBuiltInProviders({}, { TYPESAFE_API_KEY: "key" }).jev).toBeInstanceOf(JevProvider);
    vi.stubEnv("TYPESAFE_API_KEY", "captured");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://captured.test/v1");
    const net = http();
    const provider = new JevProvider({ fetch: net.fetch });
    vi.stubEnv("TYPESAFE_API_KEY", "changed");
    vi.stubEnv("TYPESAFE_BASE_URL", "https://changed.test");
    await provider.complete({ model: "jev-latest", input: jevDialect.toBaseline(input) });
    expect(net.calls[0]!.url).toBe("https://captured.test/v1/systemone");
    expect(net.calls[0]!.headers.get("authorization")).toBe("Bearer captured");
  });

  it("uses only TypeSafe credentials and respects an explicitly disabled key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("OPENAI_BASE_URL", "https://openai.invalid");
    vi.stubEnv("TYPESAFE_API_KEY", "ambient");
    const net = http();
    const provider = new JevProvider({ apiKey: "", fetch: net.fetch });
    await expect(provider.complete({ model: "jev-latest", input: jevDialect.toBaseline(input) })).rejects.toThrow("Jev requires");
    await expect(provider.listModels()).rejects.toThrow("Jev requires");
    expect(net.calls).toHaveLength(0);
  });

  it.each([401, 422, 429, 529])("retains HTTP %i and does not retry", async (status) => {
    const net = http({ detail: "error" }, status);
    await expect(new JevProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "jev-latest", input: jevDialect.toBaseline(input) }))
      .rejects.toMatchObject({ name: "ProviderHttpError", status, body: '{"detail":"error"}' });
    expect(net.calls).toHaveLength(1);
  });

  it("passes a bounded timeout signal to the injected transport", async () => {
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      await new Promise<void>((resolve) => init!.signal!.addEventListener("abort", () => resolve(), { once: true }));
      init!.signal!.throwIfAborted();
      return new Response();
    };
    await expect(new JevProvider({ apiKey: "key", timeoutMs: 5, fetch }).listModels()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it.each([
    { temperature: 0 }, { tools: [] }, { responseFormat: { type: "json" } },
    { extensions: { openai: { logprobs: true } } },
    { messages: [{ role: "system", content: "state" }] },
    { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://img.test" } }] }] },
    { messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] },
  ])("rejects unsupported baseline semantics before fetching %#", async (extra) => {
    const net = http();
    const canonical = { ...jevDialect.toBaseline(input), ...extra } as BridgeInput;
    await expect(new JevProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "jev-latest", input: canonical })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    { state: null, questions: input.questions }, { state: "s", questions: {} },
    { state: "s", questions: { q: { type: "score", instructions: "Rate", criteria: ["one"] } } },
    { state: "s", questions: { q: { type: "score", instructions: "Rate", criteria: Array(11).fill("level") } } },
    { state: "s", questions: { q: { type: "choice", instructions: "Choose", criteria: {} } } },
    { state: "s", questions: { q: { type: "choice", instructions: "Choose", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])) } } },
    { state: "s", questions: { q: { type: "noul", instructions: false } } },
  ])("validates native request primitives %#", (invalid) => {
    expect(() => jevDialect.toBaseline(invalid as unknown as JevInput)).toThrow(BridgeError);
  });

  it.each([
    null, { ...output, model: null }, { ...output, usage: { input_tokens: -1, output_tokens: 0 } },
    { ...output, answers: {} }, { ...output, answers: { urgent: { type: "noul", noul: 2 } } },
    { ...output, answers: { ...output.answers, urgent: { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 } } },
  ])("rejects malformed or mismatched upstream answers %#", async (invalid) => {
    const net = http(invalid);
    await expect(new JevProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "jev-latest", input: jevDialect.toBaseline(input) })).rejects.toBeInstanceOf(BridgeError);
  });

  it("rejects typed-answer projection from chat and Jev request conversion to another provider", async () => {
    expect(() => jevDialect.fromBaseline(baselineResponse())).toThrow(UnsupportedFeatureError);
    const net = http();
    await expect(new OpenAIProvider({ apiKey: "key", fetch: net.fetch }).complete({ model: "chat", input: jevDialect.toBaseline(input) })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(net.calls).toHaveLength(0);
    const bridge = createBridge({ providers: { jev: new JevProvider({ apiKey: "key", fetch: net.fetch }) } });
    await expect(bridge.getAllowance({ provider: "jev" })).rejects.toMatchObject({ feature: "allowance" });
  });
});
