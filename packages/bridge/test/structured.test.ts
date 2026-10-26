import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createBridge, baselineToStructuredOutput, UnsupportedFeatureError, type BridgeOutput } from "../src/index.js";
import { baselineResponse } from "./fixtures.js";

type Answer = { approved: boolean; labels: string[] };
const answer: Answer = { approved: true, labels: ["billing"] };
const input = { messages: [] };

function setup(output: BridgeOutput = { ...baselineResponse(), structured: answer }) {
  const raw = { wire: true, answer, extra: { future: 1 } };
  const converter = vi.fn(() => { throw new UnsupportedFeatureError("broken", "projection"); });
  const bridge = createBridge({
    providers: { custom: { complete: async () => ({ output, raw }) } },
    dialects: { broken: { fromBaseline: converter } },
  });
  return { bridge, raw, converter };
}

describe("structured answers and response modes", () => {
  it("returns caller-typed native answers without parsing or dropping native fields", async () => {
    const { bridge, raw } = setup();
    const response = await bridge.complete<Answer, typeof raw>({
      provider: "custom", model: "m", input, outputDialect: "structured", response: "both",
    });
    expectTypeOf(response.output).toEqualTypeOf<Answer>();
    expectTypeOf(response.raw).toEqualTypeOf<typeof raw>();
    expect(response.output).toBe(answer);
    expect(response.raw).toBe(raw);
    expect(response.dialect).toBe("structured");
    expect(response.toDialect("bridge").structured).toBe(answer);
    expectTypeOf(response.toDialect<Answer>("structured")).toEqualTypeOf<Answer>();
    expect(response.toDialect<Answer>("structured")).toBe(answer);
  });

  it("omits raw when only projected output is requested", async () => {
    const { bridge } = setup();
    const response = await bridge.complete<Answer>({
      provider: "custom", model: "m", input, outputDialect: "structured", response: "output",
    });
    expectTypeOf(response.output).toEqualTypeOf<Answer>();
    expect(response.output).toBe(answer);
    expect(response).not.toHaveProperty("raw");
    // @ts-expect-error output mode excludes raw from the type too.
    void response.raw;
  });

  it("returns only raw, skipping even an incompatible output projection", async () => {
    const { bridge, raw, converter } = setup();
    const response = await bridge.complete<typeof raw>({
      provider: "custom", model: "m", input, outputDialect: "broken", response: "raw",
    });
    expectTypeOf(response).toEqualTypeOf<typeof raw>();
    expect(response).toBe(raw);
    expect(converter).not.toHaveBeenCalled();
  });

  it("parses a complete JSON chat response and concatenates text blocks", async () => {
    const output = baselineResponse();
    output.choices[0]!.message.content = JSON.stringify(answer);
    const { bridge } = setup(output);
    const response = await bridge.complete<Answer>({ provider: "custom", model: "m", input, outputDialect: "structured" });
    expect(response.output).toEqual(answer);
    output.choices[0]!.message.content = [{ type: "text", text: '{"approved":' }, { type: "text", text: "true}" }];
    expect(baselineToStructuredOutput(output)).toEqual({ approved: true });
    output.choices[0]!.message.content = "null";
    expect(baselineToStructuredOutput(output)).toBeNull();
  });

  it("rejects invalid JSON, multiple candidates, partial answers, refusals and tool calls", () => {
    const output = baselineResponse();
    expect(() => baselineToStructuredOutput(output)).toThrow(UnsupportedFeatureError);
    output.choices[0]!.message.content = "{}";
    output.choices.push({ ...output.choices[0]!, index: 1 });
    expect(() => baselineToStructuredOutput(output)).toThrow(UnsupportedFeatureError);
    output.choices.pop();
    output.choices[0]!.finishReason = "length";
    expect(() => baselineToStructuredOutput(output)).toThrow(UnsupportedFeatureError);
    output.choices[0]!.finishReason = "stop";
    for (const content of [
      [{ type: "refusal" as const, text: "{}" }],
      [{ type: "tool-call" as const, id: "1", name: "act", input: {} }],
    ]) {
      output.choices[0]!.message.content = content;
      expect(() => baselineToStructuredOutput(output)).toThrow(UnsupportedFeatureError);
    }
  });

  it("preserves null native answers and reserves the built-in dialect name", () => {
    expect(baselineToStructuredOutput({ ...baselineResponse(), structured: null })).toBeNull();
    expect(() => createBridge({ providers: {}, dialects: { structured: { fromBaseline: () => answer } } })).toThrow("built-in dialect");
  });
});
