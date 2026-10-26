import type { BridgeInput, BridgeOutput } from "../baseline.js";
import type { DialectService } from "../types.js";

export const bridgeDialect = {
  toBaseline: (input: BridgeInput) => input,
  fromBaseline: (output: BridgeOutput) => output,
} satisfies DialectService<BridgeInput, BridgeOutput>;
