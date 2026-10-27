import { UnsupportedFeatureError } from "../errors.js";
import type { ContentBlock, NativeFields, BridgeMessage, WireDialect } from "../baseline.js";

export function blocks(message: BridgeMessage): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

export function extras(value: object, handled: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key, v]) => !handled.includes(key) && v !== undefined));
}

export function nativeFields(dialect: WireDialect, value: Record<string, unknown>): NativeFields {
  return Object.keys(value).length ? { [dialect]: value } : {};
}

/** Reject foreign request options rather than silently changing request semantics. */
export function requestFields(fields: NativeFields | undefined, dialect: WireDialect): Record<string, unknown> {
  for (const [source, value] of Object.entries(fields ?? {})) {
    if (source !== dialect && Object.keys(value ?? {}).length) {
      throw new UnsupportedFeatureError(dialect, `${source} native fields (${Object.keys(value ?? {}).join(", ")})`);
    }
  }
  return fields?.[dialect] ?? {};
}

export function unsupported(target: string, feature: string): never {
  throw new UnsupportedFeatureError(target, feature);
}

export function requireAbsent(target: string, value: object, keys: readonly string[]): void {
  for (const key of keys) {
    if ((value as Record<string, unknown>)[key] !== undefined) unsupported(target, key);
  }
}

export function parseArguments(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

export function toolInput(input: unknown, argumentsText?: string, target = "anthropic"): unknown {
  if (input !== undefined) return input;
  if (argumentsText !== undefined) {
    const parsed = parseArguments(argumentsText);
    if (parsed !== undefined) return parsed;
  }
  return unsupported(target, "invalid JSON tool arguments");
}

export function textOnly(content: ContentBlock[], target: string): string {
  return content.map((block) => {
    if (block.cacheControl || Object.values(block.extensions ?? {}).some((v) => Object.keys(v ?? {}).length)) unsupported(target, "metadata in flattened text content");
    if (block.type !== "text") return unsupported(target, `${block.type} in text-only content`);
    if (block.citations?.length) unsupported(target, "citations in flattened text content");
    return block.text;
  }).join("");
}
