import { randomUUID } from "node:crypto";
import type { BridgeInput, BridgeOutput, EvaluationBlock } from "../baseline.js";
import { isEvaluationBlock, evaluationAnswers } from "../evaluation.js";
import type { DialectService } from "../types.js";
import { BridgeError } from "../errors.js";
import { blocks, extras, nativeFields, requestFields, requireAbsent, textOnly, unsupported } from "./shared.js";

export type JevJson = string | number | boolean | null | JevJson[] | { [key: string]: JevJson };
export type JevDescription = string | JevJson[] | { [key: string]: JevJson };
export type JevQuestion =
  | { type: "noul"; instructions: JevDescription; criteria?: { true?: JevDescription; false?: JevDescription } }
  | { type: "choice"; instructions: JevDescription; criteria: Record<string, JevDescription | null> }
  | { type: "score"; instructions: JevDescription; criteria: JevDescription[] };
export interface JevInput<Questions extends { [K in keyof Questions]: JevQuestion } = Record<string, JevQuestion>> {
  state: JevDescription;
  questions: { [K in keyof Questions]: Questions[K] };
}
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export interface JevOutput<Answers extends { [K in keyof Answers]: JevAnswer } = Record<string, JevAnswer>> {
  model: string;
  answers: { [K in keyof Answers]: Answers[K] };
  usage: { input_tokens: number; output_tokens: number; [key: string]: unknown };
  [key: string]: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(value: unknown): value is JevJson {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (Array.isArray(value) ? value.every(json) : record(value) && Object.values(value).every(json));
}
function description(value: unknown): value is JevDescription {
  return (typeof value === "string" || Array.isArray(value) || record(value)) && json(value);
}

/** Validate native JSON at the dialect boundary, including HTTP extension payloads. */
export function validateJevInput(value: unknown): asserts value is JevInput {
  if (!record(value) || !description(value.state) || !record(value.questions) || !Object.keys(value.questions).length) {
    unsupported("jev", "Jev requires state and a nonempty questions map");
  }
  requireAbsent("jev", value, Object.keys(extras(value, ["state", "questions"])));
  for (const question of Object.values(value.questions)) {
    if (!record(question) || !description(question.instructions)) unsupported("jev", "question instructions require text, an object or an array");
    requireAbsent("jev", question, Object.keys(extras(question, ["type", "instructions", "criteria"])));
    const criteria = question.criteria;
    if (question.type === "noul") {
      if (criteria !== undefined && (!record(criteria) || Object.entries(criteria).some(([key, v]) => !["true", "false"].includes(key) || !description(v)))) {
        unsupported("jev", "Jev noul criteria must describe true or false");
      }
    } else if (question.type === "choice") {
      if (!record(criteria) || Object.keys(criteria).length < 1 || Object.keys(criteria).length > 255
        || !Object.values(criteria).every((v) => v === null || description(v))) unsupported("jev", "Jev choice requires 1–255 criteria");
    } else if (question.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(description)) unsupported("jev", "Jev score requires 2–10 criteria");
    } else unsupported("jev", "Jev question type must be noul, choice or score");
  }
}

export function jevInputToBaseline(input: JevInput): BridgeInput {
  validateJevInput(input);
  return {
    messages: [{ role: "user", content: typeof input.state === "string" ? input.state
      : [{ type: "native", dialect: "jev", value: { state: input.state } }] }],
    extensions: { jev: { questions: input.questions } },
  };
}

export function baselineToJevInput(input: BridgeInput): JevInput {
  requireAbsent("jev", input, Object.keys(extras(input, ["messages", "extensions"])));
  const fields = requestFields(input.extensions, "jev");
  requireAbsent("jev", fields, Object.keys(extras(fields, ["questions"])));
  if (input.messages.length !== 1 || input.messages[0]!.role !== "user") unsupported("jev", "state requires one user message");
  const message = input.messages[0]!;
  requireAbsent("jev", message, ["name"]);
  if (Object.keys(requestFields(message.extensions, "jev")).length) unsupported("jev", "message metadata");
  const content = blocks(message);
  let state: unknown;
  if (content.length === 1 && content[0]!.type === "native") {
    const block = content[0]!;
    if (block.dialect !== "jev") unsupported("jev", `${block.dialect} content block`);
    if (block.cacheControl || Object.keys(requestFields(block.extensions, "jev")).length) unsupported("jev", "state metadata");
    requireAbsent("jev", block.value, Object.keys(extras(block.value, ["state"])));
    state = block.value.state;
  } else state = textOnly(content, "jev");
  const native = { state, questions: fields.questions };
  validateJevInput(native);
  return native;
}

const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function validateJevOutput(value: unknown): asserts value is JevOutput {
  if (!record(value) || typeof value.model !== "string" || !value.model || !record(value.answers)
    || !record(value.usage) || !tokens(value.usage.input_tokens) || !tokens(value.usage.output_tokens)) throw new BridgeError("Jev returned an invalid evaluation response");
  for (const answer of Object.values(value.answers)) {
    if (!record(answer)) throw new BridgeError("Jev returned an invalid answer");
    if (answer.type === "noul" && probability(answer.noul)) continue;
    if ((answer.type === "choice" || answer.type === "score") && probability(answer.confidence)
      && record(answer.probabilities) && Object.keys(answer.probabilities).length && Object.values(answer.probabilities).every(probability)) {
      if (answer.type === "choice" && typeof answer.choice === "string" && Object.hasOwn(answer.probabilities, answer.choice)) continue;
      if (answer.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score)
        && record(answer.legend) && Object.values(answer.legend).every((v) => typeof v === "string")) continue;
    }
    throw new BridgeError("Jev returned an invalid answer");
  }
}

export function jevOutputToBaseline(output: JevOutput): BridgeOutput {
  validateJevOutput(output);
  const content: EvaluationBlock[] = Object.entries(output.answers).map(([id, answer]) => {
    if (answer.type === "noul") return {
      type: "boolean", id, value: null, probability: answer.noul,
      extensions: nativeFields("jev", extras(answer, ["type", "noul"])),
    };
    if (answer.type === "choice") return {
      type: "choice", id, value: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence,
      extensions: nativeFields("jev", extras(answer, ["type", "choice", "probabilities", "confidence"])),
    };
    return {
      type: "score", id, value: answer.score, legend: answer.legend, probabilities: answer.probabilities, confidence: answer.confidence,
      extensions: nativeFields("jev", extras(answer, ["type", "score", "legend", "probabilities", "confidence"])),
    };
  });
  return {
    id: `jev-${randomUUID()}`, model: output.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finishReason: "stop" }],
    usage: { inputTokens: output.usage.input_tokens, outputTokens: output.usage.output_tokens,
      totalTokens: output.usage.input_tokens + output.usage.output_tokens,
      extensions: { jev: extras(output.usage, ["input_tokens", "output_tokens"]) } },
    extensions: { jev: { ...extras(output, ["model", "usage"]), answers: output.answers } },
  };
}

export function baselineToJevOutput(output: BridgeOutput): JevOutput {
  if (output.choices.length !== 1) unsupported("jev", "multiple response candidates");
  const content = blocks(output.choices[0]!.message);
  let answers: unknown;
  if (evaluationAnswers(content, "jev")) {
    answers = Object.fromEntries(content.filter(isEvaluationBlock).map((block) => {
      const extra = block.extensions?.jev;
      if (block.type === "boolean") {
        if (block.probability === undefined && block.value === null) unsupported("jev", "boolean answer without a value or probability");
        return [block.id, { ...extra, type: "noul", noul: block.probability ?? Number(block.value) }];
      }
      if (block.probabilities === undefined || block.confidence === undefined) unsupported("jev", "evaluation without probabilities or confidence");
      if (block.type === "choice") return [block.id, {
        ...extra, type: "choice", choice: block.value, probabilities: block.probabilities, confidence: block.confidence,
      }];
      if (block.legend === undefined) unsupported("jev", "score answer without a legend");
      return [block.id, { ...extra, type: "score", score: block.value, legend: block.legend,
        probabilities: block.probabilities, confidence: block.confidence }];
    }));
  } else if (typeof output.choices[0]!.message.content === "string" && output.extensions?.jev?.answers) {
    answers = output.extensions.jev.answers; // Compatibility with older JSON-text bridge responses.
  } else unsupported("jev", "response without evaluation answers");
  if (output.usage.inputTokens === null || output.usage.outputTokens === null) unsupported("jev", "unknown token usage");
  const native = { ...output.extensions?.jev, model: output.model, answers,
    usage: { ...output.usage.extensions?.jev, input_tokens: output.usage.inputTokens, output_tokens: output.usage.outputTokens } };
  validateJevOutput(native);
  return native;
}

export const jevDialect = { toBaseline: jevInputToBaseline, fromBaseline: baselineToJevOutput } satisfies DialectService<JevInput, JevOutput>;
