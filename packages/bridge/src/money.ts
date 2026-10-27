import { BridgeError } from "./errors.js";

/** sign, integer digits, fraction digits (either form), exponent. */
const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

const MAX_EXPONENT = 400;

/**
 * Convert a money amount to its minor units (`fractionDigits` decimal places,
 * 2 = cents) by shifting the digits of the decimal string.
 *
 * The naive `Math.round(value * 10 ** fractionDigits)` is not used: it answers
 * 100 for `1.005`, whose correct rounding is 101. Rounding is half-up at
 * `fractionDigits`; exponent forms (`1e-7`, `2.5e+3`) are expanded first.
 *
 * @throws {BridgeError} on negative, empty, non-numeric or non-finite input.
 */
export function toMinorUnits(value: string | number, fractionDigits = 2): number {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
    throw new BridgeError(`fractionDigits must be a non-negative integer, got ${String(fractionDigits)}`);
  }
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const match = DECIMAL.exec(text);
  if (match === null) {
    throw new BridgeError(`Cannot convert ${String(value)} to minor units: not a finite decimal number`);
  }
  const sign = match[1] ?? "";
  const intDigits = match[2] ?? "0";
  const fractionDigitsOfValue = match[3] ?? match[4] ?? "";
  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  // Bound the exponent before any BigInt expansion (10n ** huge would hang or exhaust memory).
  if (!Number.isFinite(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    throw new BridgeError(`Cannot convert ${String(value)} to minor units: exponent out of range`);
  }

  // value = digits * 10 ** -scale
  let digits = BigInt(intDigits + fractionDigitsOfValue);
  let scale = fractionDigitsOfValue.length - exponent;
  if (scale < 0) {
    digits *= 10n ** BigInt(-scale);
    scale = 0;
  }
  if (sign === "-" && digits !== 0n) {
    throw new BridgeError(`Cannot convert ${String(value)} to minor units: amount is negative`);
  }

  const shift = fractionDigits - scale;
  let result: bigint;
  if (shift >= 0) {
    result = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const whole = digits / divisor;
    const remainder = digits % divisor;
    result = remainder * 2n >= divisor ? whole + 1n : whole;
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BridgeError(`Cannot convert ${String(value)} to minor units: result exceeds the safe integer range`);
  }
  return Number(result);
}
