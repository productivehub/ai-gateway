import { BridgeError, UnknownDialectError, UnknownProviderError, UnsupportedFeatureError } from "./errors.js";
import { bridgeDialect } from "./dialects/bridge.js";
import { structuredDialect } from "./dialects/structured.js";
import type { BridgeInput } from "./baseline.js";
import type {
  DialectInput, DialectRegistry, DialectService, ProviderRegistry,
  BridgeRequest, BridgeConfig, BridgeResponse, BridgeOutputResponse, ListModelsRequest, BridgeModelsResponse,
  AllowanceRequest, BridgeAllowanceResponse, BridgeResponseMeta,
} from "./types.js";

type WithBaseline<D extends DialectRegistry> = D & { bridge: typeof bridgeDialect; structured: typeof structuredDialect };
type CompletionRequest<P extends string, D extends DialectRegistry> = BridgeRequest<P, D>;

export interface Bridge<P extends ProviderRegistry = ProviderRegistry, D extends DialectRegistry = DialectRegistry> {
  complete<Raw = unknown>(req: CompletionRequest<keyof P & string, WithBaseline<D>> & { response: "raw" }): Promise<Raw>;
  complete<Output = unknown>(req: CompletionRequest<keyof P & string, WithBaseline<D>> & {
    outputDialect: keyof WithBaseline<D> & string; response: "output";
  }): Promise<BridgeOutputResponse<WithBaseline<D>, Output>>;
  complete<Output = unknown, Raw = unknown>(req: CompletionRequest<keyof P & string, WithBaseline<D>> & {
    outputDialect: keyof WithBaseline<D> & string; response?: "both";
  }): Promise<BridgeResponse<WithBaseline<D>, Output, Raw>>;
  complete(req: CompletionRequest<keyof P & string, WithBaseline<D>> & {
    outputDialect?: undefined; response: "output";
  }): Promise<BridgeOutputResponse<WithBaseline<D>>>;
  complete(req: CompletionRequest<keyof P & string, WithBaseline<D>> & {
    outputDialect?: undefined; response?: "both";
  }): Promise<BridgeResponse<WithBaseline<D>>>;
  listModels(req: ListModelsRequest<keyof P & string>): Promise<BridgeModelsResponse>;
  getAllowance(req: AllowanceRequest<keyof P & string>): Promise<BridgeAllowanceResponse>;
  providers(): (keyof P & string)[];
  dialects(): (keyof WithBaseline<D> & string)[];
}

/** Startup injection creates isolated registries; there is no shared global state. */
export function createBridge<const P extends ProviderRegistry, const D extends DialectRegistry = {}>(config: BridgeConfig<P, D>): Bridge<P, D> {
  const providers = new Map(Object.entries(config.providers));
  for (const name of ["bridge", "structured"]) {
    if (config.dialects && name in config.dialects) throw new BridgeError(`"${name}" is a built-in dialect`);
  }
  const dialects = new Map<string, DialectService<never, unknown>>([
    ["bridge", bridgeDialect], ["structured", structuredDialect], ...Object.entries(config.dialects ?? {}),
  ]);

  function service(name: string): DialectService<unknown, unknown> {
    const value = dialects.get(name);
    if (!value) throw new UnknownDialectError(name);
    return value as DialectService<unknown, unknown>;
  }

  /** Shared timing: returns a function that stamps the response meta when called. */
  function startTimer(): () => BridgeResponseMeta {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    return () => ({ startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - start });
  }

  async function complete(req: CompletionRequest<keyof P & string, WithBaseline<D>>): Promise<unknown> {
    const meta = startTimer();
    const provider = providers.get(req.provider);
    if (!provider) throw new UnknownProviderError(req.provider);
    const mode = req.response ?? "both";
    if (!["both", "output", "raw"].includes(mode)) throw new BridgeError("Unknown response mode");
    const outputDialect = req.outputDialect ?? "bridge";
    const outputService = service(outputDialect);
    let input: BridgeInput;
    if (req.dialect === undefined) input = req.input as BridgeInput;
    else {
      const converter = service(req.dialect);
      if (!converter.toBaseline) throw new UnsupportedFeatureError(req.dialect, "input conversion (response-only dialect)");
      input = converter.toBaseline(req.input as DialectInput<typeof converter>);
    }
    const result = await provider.complete({ model: req.model, input });
    if (mode === "raw") return result.raw;
    const response: BridgeOutputResponse<WithBaseline<D>, unknown> = {
      provider: req.provider, model: req.model, dialect: outputDialect,
      output: outputService.fromBaseline(result.output), usage: result.output.usage,
      meta: meta(),
      toDialect: ((name: string) => service(name).fromBaseline(result.output)) as BridgeOutputResponse<WithBaseline<D>>["toDialect"],
    };
    return mode === "output" ? response : { ...response, raw: result.raw };
  }

  return {
    complete: complete as Bridge<P, D>["complete"],
    async getAllowance(req) {
      const meta = startTimer();
      const provider = providers.get(req.provider);
      if (!provider) throw new UnknownProviderError(req.provider);
      if (!provider.getAllowance) throw new UnsupportedFeatureError(req.provider, "allowance");
      const result = await provider.getAllowance();
      return { ...result, provider: req.provider, meta: meta() };
    },
    async listModels(req) {
      const meta = startTimer();
      const provider = providers.get(req.provider);
      if (!provider) throw new UnknownProviderError(req.provider);
      if (!provider.listModels) throw new UnsupportedFeatureError(req.provider, "model discovery");
      const result = await provider.listModels();
      return {
        provider: req.provider, models: result.models, raw: result.raw,
        meta: meta(),
      };
    },
    providers: () => [...providers.keys()] as (keyof P & string)[],
    dialects: () => [...dialects.keys()] as (keyof WithBaseline<D> & string)[],
  };
}
