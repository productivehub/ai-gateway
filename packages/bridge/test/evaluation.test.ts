import { describe, expect, it } from "vitest";
import {
  createBridge, openaiDialect, anthropicDialect, ollamaDialect, jevDialect, evaluationAnswers,
  type ContentBlock, type EvaluationBlock, UnsupportedFeatureError,
} from "../src/index.js";
import { baselineResponse } from "./fixtures.js";

const content: EvaluationBlock[] = [
  { type: "boolean", id: "urgent", value: null, probability: 0.25 },
  { type: "choice", id: "team", value: "billing", probabilities: { billing: 0.8, support: 0.2 }, confidence: 0.7 },
  { type: "score", id: "priority", value: 0.75, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.6 },
];
const answers = {
  urgent: { type: "boolean", value: null, probability: 0.25 },
  team: { type: "choice", value: "billing", probabilities: { billing: 0.8, support: 0.2 }, confidence: 0.7 },
  priority: { type: "score", value: 0.75, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.6 },
};
const output = () => {
  const result = baselineResponse();
  result.choices[0]!.message.content = structuredClone(content);
  return result;
};

describe("provider-neutral evaluations", () => {
  it("carries evaluations in the regular answer content and projects them without native extensions", async () => {
    const raw = { custom: true };
    const canonical = output();
    const bridge = createBridge({ providers: { decisions: { complete: async () => ({ output: canonical, raw }) } } });
    const response = await bridge.complete({ provider: "decisions", model: "m", input: { messages: [] } });
    expect(response.output.choices[0]!.message.content).toEqual(content);
    expect(response.toDialect("structured")).toEqual(answers);
    expect(response.raw).toBe(raw);
  });

  it("projects evaluation data to all chat dialects without dropping probabilities or confidence", () => {
    const canonical = output();
    expect(JSON.parse(openaiDialect.fromBaseline(canonical).choices[0]!.message.content!)).toEqual(answers);
    const anthropic = anthropicDialect.fromBaseline(canonical).content[0]!;
    expect(anthropic.type).toBe("text");
    if (anthropic.type === "text") expect(JSON.parse(anthropic.text)).toEqual(answers);
    expect(JSON.parse(ollamaDialect.fromBaseline(canonical).message.content)).toEqual(answers);
  });

  it("preserves surrounding chat content when projecting evaluation groups", () => {
    const canonical = output();
    canonical.choices[0]!.message.content = [{ type: "text", text: "Result: " }, ...content];
    expect(openaiDialect.fromBaseline(canonical).choices[0]!.message.content).toBe(`Result: ${JSON.stringify(answers)}`);
  });

  it("keeps the native block available alongside typed evaluations", async () => {
    const native: ContentBlock = { type: "native", dialect: "custom", value: { trace: [1, 2], future: true } };
    const canonical = output();
    canonical.choices[0]!.message.content = [...content, native];
    const bridge = createBridge({ providers: { decisions: { complete: async () => ({ output: canonical, raw: native.value }) } } });
    const response = await bridge.complete({ provider: "decisions", model: "m", input: { messages: [] } });
    expect(response.output.choices[0]!.message.content).toContainEqual(native);
    expect(response.raw).toBe(native.value);
  });

  it("rejects duplicate answer IDs and incomplete projections instead of losing data", () => {
    const canonical = output();
    canonical.choices[0]!.message.content = [content[0]!, { type: "boolean", id: "urgent", value: null, probability: 0.8 }];
    expect(() => evaluationAnswers(canonical.choices[0]!.message.content as ContentBlock[])).toThrow(UnsupportedFeatureError);
    expect(() => jevDialect.fromBaseline(canonical)).toThrow(UnsupportedFeatureError);
    canonical.choices[0]!.message.content = [{ type: "choice", id: "team", value: "billing" }];
    expect(() => jevDialect.fromBaseline(canonical)).toThrow(UnsupportedFeatureError);
  });
});
