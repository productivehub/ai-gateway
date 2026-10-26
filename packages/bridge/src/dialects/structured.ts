import type { BridgeOutput } from "../baseline.js";
import { unsupported } from "./shared.js";
import { evaluationAnswers } from "../evaluation.js";

/** Prefer explicit structured data, then typed evaluations, then one complete JSON chat answer. */
export function baselineToStructuredOutput<T = unknown>(output: BridgeOutput): T {
  if (Object.hasOwn(output, "structured")) return output.structured as T;
  if (output.choices.length !== 1) unsupported("structured", "response without exactly one candidate");
  const choice = output.choices[0]!;
  if (choice.finishReason !== "stop") unsupported("structured", "incomplete or non-answer response");
  const content = choice.message.content;
  if (Array.isArray(content)) {
    const answers = evaluationAnswers(content);
    if (answers !== undefined) return answers as T;
  }
  const text = typeof content === "string" ? content : content.map((block) => {
    if (block.type !== "text") unsupported("structured", `${block.type} content`);
    return block.text;
  }).join("");
  try { return JSON.parse(text) as T; }
  catch { return unsupported("structured", "non-JSON answer"); }
}

export const structuredDialect = { fromBaseline: baselineToStructuredOutput };
