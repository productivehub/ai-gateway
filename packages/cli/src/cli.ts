/** Command-line wrapper. Every command speaks the HTTP contract, in-process or against a remote server. */
import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { BridgeCost, ContentBlock, BridgeInput, BridgeModelsResponse } from "@productivehub/ai-bridge";
import {
  createDefaultGateway, loadGatewayConfig,
  type Environment, type GatewayConfig, type GatewayResponse, type GatewayKeyInfo, type GatewayModelRoute,
  type GatewayAllowanceResponse,
} from "@productivehub/ai-gateway-api";
import { listenGateway, type FetchApp, type GatewayListener } from "@productivehub/ai-gateway-api/listener";

export interface CliIO {
  env?: Environment;
  stdin?: AsyncIterable<string | Uint8Array> & { isTTY?: boolean };
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
  /** Used for `--url` requests. */
  fetch?: typeof globalThis.fetch;
  /** Replaces the in-process app built from config and environment. */
  app?: FetchApp;
  /** `serve` closes its listener when aborted; defaults to SIGINT/SIGTERM. */
  signal?: AbortSignal;
  onListen?: (listener: GatewayListener) => void;
}

export const usage = `Usage: ai-gateway <command> [options]

Commands:
  serve                       Start the HTTP API on Node or Deno
  complete <model> [prompt]   Run one completion; the prompt is read from stdin when omitted
  models                      List the provider's model catalog
  allowance                   Show the account's remaining allowance and usage
  keys                        List configured accounts

Global options:
  --config <path>             GatewayConfig JSON (env AI_GATEWAY_CONFIG)
  --url <url>                 Call a running ai-gateway server, e.g. http://localhost:3000/api/ai (env AI_GATEWAY_URL)
  -h, --help                  Show this help

serve:     --port <n>  --hostname <host>
complete:  --key <name>  --provider <name>  --dialect <name>  -s, --system <text>
           --max-tokens <n>  --temperature <n>  --input <file|->  --json
models:    --key <name>  --provider <name>  --configured  --json
allowance: --key <name>  --provider <name>  --json
keys:      --json

complete prints the reply text for the bridge dialect and the output JSON for any
other dialect; --json prints the full response envelope.`;

class UsageError extends Error {}
class RequestError extends Error {}

const globalOptions = {
  config: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsConfig["options"];
const selection = { key: { type: "string" }, provider: { type: "string" } } satisfies ParseArgsConfig["options"];
const commandOptions = {
  serve: { port: { type: "string" }, hostname: { type: "string" } },
  complete: {
    ...selection, dialect: { type: "string" }, system: { type: "string", short: "s" },
    "max-tokens": { type: "string" }, temperature: { type: "string" }, input: { type: "string" }, json: { type: "boolean" },
  },
  models: { ...selection, configured: { type: "boolean" }, json: { type: "boolean" } },
  allowance: { ...selection, json: { type: "boolean" } },
  keys: { json: { type: "boolean" } },
} satisfies Record<string, ParseArgsConfig["options"]>;
type Command = keyof typeof commandOptions;

const allOptions = { ...globalOptions, ...commandOptions.serve, ...commandOptions.complete, ...commandOptions.models, ...commandOptions.allowance, ...commandOptions.keys };

/** One parse over every option keeps the values typed; per-command validity is checked after. */
function parse(command: Command, args: string[]) {
  let parsed;
  try { parsed = parseArgs({ args, options: allOptions, allowPositionals: true, strict: true }); }
  catch (error) { throw new UsageError((error as Error).message); }
  for (const name of Object.keys(parsed.values)) {
    if (!Object.hasOwn(globalOptions, name) && !Object.hasOwn(commandOptions[command], name)) throw new UsageError(`${command} does not accept --${name}`);
  }
  return parsed;
}

function number(value: string | undefined, name: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result) || (integer && !Number.isSafeInteger(result))) throw new UsageError(`Invalid --${name}`);
  return result;
}

async function readStdin(stdin: CliIO["stdin"]): Promise<string> {
  if (!stdin) return "";
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stdin) text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function query(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== undefined) params.set(name, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function replyText(response: GatewayResponse): string | undefined {
  if (response.dialect !== "bridge") return undefined;
  const content = (response.output as GatewayResponse<{ choices?: { message?: { content?: string | ContentBlock[] } }[] }>["output"]).choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  const texts = content?.flatMap((block) => block.type === "text" ? [block.text] : []);
  return texts?.length ? texts.join("") : undefined;
}

function money(cost: BridgeCost | undefined): string {
  return cost ? `${(cost.amount / 100).toFixed(2)} ${cost.currency}` : "-";
}

function pct(fraction: number | null): string {
  return fraction === null ? "-" : `${Math.round(fraction * 100)}%`;
}

/** One tab-separated row per allowance window, then the usage line when the provider reports one. */
function allowanceRows(allowance: GatewayAllowanceResponse): string[] {
  const rows: string[] = [];
  if (allowance.available !== null) rows.push(["available", String(allowance.available)].join("\t"));
  for (const window of allowance.windows) rows.push([
    window.id, window.kind, money(window.remaining), money(window.limit), pct(window.remainingFraction),
    window.period?.resetsAt ?? window.period?.until ?? "-",
  ].join("\t"));
  const usage = allowance.usage;
  if (usage) rows.push(["usage", usage.from, usage.until, usage.requests ?? "-", money(usage.cost)].join("\t"));
  return rows;
}

/** Runs one command and resolves to a process exit code: 0 success, 1 request failure, 2 usage error. */
export async function runCli(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const print = (text: string) => { stdout.write(text.endsWith("\n") ? text : `${text}\n`); };
  const printJson = (value: unknown) => print(JSON.stringify(value, null, 2));
  try {
    const [command, ...args] = argv;
    if (!command) { stderr.write(`${usage}\n`); return 2; }
    if (command === "-h" || command === "--help" || command === "help") { print(usage); return 0; }
    if (!Object.hasOwn(commandOptions, command)) throw new UsageError(`Unknown command "${command}"`);
    const { values: options, positionals } = parse(command as Command, args);
    if (options.help) { print(usage); return 0; }
    const remote = options.url ?? (env.AI_GATEWAY_URL?.trim() || undefined);
    if (remote && options.config) throw new UsageError("Choose --config or --url, not both");
    const configPath = options.config ?? (env.AI_GATEWAY_CONFIG?.trim() || undefined);
    const loadConfig = async (): Promise<GatewayConfig | undefined> => configPath ? loadGatewayConfig(configPath) : undefined;

    if (command === "serve") {
      if (remote) throw new UsageError("serve does not accept --url");
      if (positionals.length) throw new UsageError("serve takes no arguments");
      const port = number(options.port, "port", true);
      const address = { env, ...(port !== undefined ? { port } : {}), ...(options.hostname !== undefined ? { hostname: options.hostname } : {}) };
      const config = io.app ? undefined : await loadConfig();
      const listener = await listenGateway(io.app ? { ...address, app: io.app } : { ...address, ...(config ? { config } : {}) });
      print(`ai-gateway (${listener.runtime}) listening on ${listener.url}`);
      io.onListen?.(listener);
      await new Promise<void>((resolve) => {
        if (io.signal) {
          if (io.signal.aborted) resolve();
          else io.signal.addEventListener("abort", () => resolve(), { once: true });
        } else {
          process.once("SIGINT", () => resolve());
          process.once("SIGTERM", () => resolve());
        }
      });
      await listener.close();
      return 0;
    }

    let app: FetchApp | undefined;
    const send = async <T>(path: string, init?: RequestInit): Promise<T> => {
      let response: Response;
      if (remote) {
        let url: URL;
        try { url = new URL(`${remote.replace(/\/+$/, "")}${path}`); } catch { throw new UsageError("Invalid --url"); }
        try { response = await (io.fetch ?? globalThis.fetch)(url, init); }
        catch (error) {
          const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
          throw new RequestError(`Cannot reach ${url.origin}: ${cause}`);
        }
      } else {
        if (!app) {
          const config = io.app ? undefined : await loadConfig();
          app = io.app ?? createDefaultGateway({ env, ...(config ? { config } : {}) });
        }
        response = await app.fetch(new Request(`http://ai-gateway.local${path}`, init));
      }
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
      if (!response.ok) {
        const message = (body as { error?: unknown } | undefined)?.error;
        throw new RequestError(`${typeof message === "string" ? message : text.trim() || response.statusText} (HTTP ${response.status})`);
      }
      if (body === undefined) throw new RequestError("Response was not JSON");
      return body as T;
    };

    if (command === "keys") {
      if (positionals.length) throw new UsageError("keys takes no arguments");
      const { keys } = await send<{ keys: GatewayKeyInfo[] }>("/keys");
      if (options.json) printJson(keys);
      else for (const key of keys) print([key.name, key.provider, key.baseURL ?? ""].join("\t").trimEnd());
      return 0;
    }

    if (command === "models") {
      if (positionals.length) throw new UsageError("models takes no arguments");
      if (options.configured) {
        if (options.key !== undefined || options.provider !== undefined) throw new UsageError("--configured lists every alias; drop --key/--provider");
        const { models } = await send<{ models: (GatewayModelRoute & { name: string; provider: string })[] }>("/models/configured");
        if (options.json) printJson(models);
        else for (const model of models) print([model.name, model.key, model.provider, model.model].join("\t"));
        return 0;
      }
      const catalog = await send<BridgeModelsResponse & { key: string }>(`/models${query({ key: options.key, provider: options.provider })}`);
      if (options.json) printJson(catalog);
      else for (const model of catalog.models) print(model.id);
      return 0;
    }

    if (command === "allowance") {
      if (positionals.length) throw new UsageError("allowance takes no arguments");
      const allowance = await send<GatewayAllowanceResponse>(`/allowance${query({ key: options.key, provider: options.provider })}`);
      if (options.json) printJson(allowance);
      else for (const row of allowanceRows(allowance)) print(row);
      return 0;
    }

    const [model, ...words] = positionals;
    if (!model) throw new UsageError("complete requires a model");
    let input: BridgeInput;
    if (options.input !== undefined) {
      if (words.length || options.system !== undefined) throw new UsageError("--input supplies the messages; drop the prompt and --system");
      let contents: string;
      try { contents = options.input === "-" ? await readStdin(io.stdin ?? process.stdin) : await readFile(options.input, "utf8"); }
      catch { throw new UsageError(`Cannot read --input ${options.input}`); }
      try { input = JSON.parse(contents) as BridgeInput; } catch { throw new UsageError("--input must be BridgeInput JSON"); }
    } else {
      const stdin = io.stdin ?? process.stdin;
      const prompt = words.length ? words.join(" ") : stdin.isTTY ? "" : (await readStdin(stdin)).trim();
      if (!prompt) throw new UsageError("Supply a prompt as arguments or on stdin");
      input = { messages: [...(options.system !== undefined ? [{ role: "system" as const, content: options.system }] : []), { role: "user", content: prompt }] };
    }
    const maxOutputTokens = number(options["max-tokens"], "max-tokens", true);
    const temperature = number(options.temperature, "temperature", false);
    input = { ...input, ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) };
    const response = await send<GatewayResponse>(`/${encodeURIComponent(model)}${query({ key: options.key, provider: options.provider, dialect: options.dialect })}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    if (options.json) printJson(response);
    else {
      const text = replyText(response);
      if (text !== undefined) print(text);
      else printJson(response.output);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`ai-gateway: ${error.message}\nRun "ai-gateway --help" for usage.\n`);
      return 2;
    }
    stderr.write(`ai-gateway: ${(error as Error).message}\n`);
    return 1;
  }
}
