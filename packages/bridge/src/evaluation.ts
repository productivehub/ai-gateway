import type { ContentBlock, EvaluationAnswer, EvaluationBlock } from "./baseline.js";
import { UnsupportedFeatureError } from "./errors.js";

export function isEvaluationBlock(block: ContentBlock): block is EvaluationBlock {
  return block.type === "boolean" || block.type === "choice" || block.type === "score";
}

/** Project a complete evaluation message to an answer map without provider-specific fields. */
export function evaluationAnswers(content: ContentBlock[], target = "structured"): Record<string, EvaluationAnswer> | undefined {
  if (!content.length || !content.every(isEvaluationBlock)) return undefined;
  const ids = new Set<string>();
  return Object.fromEntries(content.map(({ id, cacheControl: _cache, extensions: _extensions, ...answer }) => {
    if (ids.has(id)) throw new UnsupportedFeatureError(target, "duplicate evaluation answer IDs");
    ids.add(id);
    return [id, answer];
  }));
}

/** Chat response dialects represent each consecutive group of evaluations as one JSON text block. */
export function evaluationContentToText(content: ContentBlock[], target: string): ContentBlock[] {
  const projected: ContentBlock[] = [];
  let pending: EvaluationBlock[] = [];
  function flush() {
    if (pending.length) projected.push({ type: "text", text: JSON.stringify(evaluationAnswers(pending, target)) });
    pending = [];
  }
  for (const block of content) {
    if (isEvaluationBlock(block)) pending.push(block);
    else { flush(); projected.push(block); }
  }
  flush();
  return projected;
}
