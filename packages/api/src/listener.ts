import { env as processEnv } from "node:process";
import { integerSetting, type Environment } from "./app.js";
import { createDefaultGateway, type DefaultGatewayOptions } from "./defaults.js";
import { parseGatewayConfig } from "./config.js";

/** Any fetch handler, such as a Hono app. */
export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

interface ListenerAddressOptions {
  port?: number;
  hostname?: string;
  env?: Environment;
}

export type ListenerOptions = ListenerAddressOptions & (
  | { app: FetchApp; providers?: never; config?: never; providerFactories?: never; defaultProvider?: never; defaultDialect?: never; maxBodyBytes?: never; onError?: never }
  | (DefaultGatewayOptions & { app?: never })
);

export interface GatewayListener {
  runtime: "node" | "deno";
  hostname: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface DenoRuntime {
  serve(options: { port: number; hostname: string; onListen(): void }, handler: (request: Request) => Response | Promise<Response>): {
    addr: { hostname: string; port: number };
    shutdown(): Promise<void>;
  };
}

/** The only package entry point that opens a socket. Port 0 selects a free port. */
export async function listenGateway(options: ListenerOptions = {}): Promise<GatewayListener> {
  const env = options.env ?? processEnv;
  const config = options.config ? parseGatewayConfig(options.config) : undefined;
  const port = integerSetting(options.port ?? config?.port ?? env.AI_GATEWAY_PORT ?? 8787, "port", 0, 65535);
  const hostname = options.hostname ?? config?.hostname ?? env.AI_GATEWAY_HOSTNAME ?? "127.0.0.1";
  if (!hostname.trim()) throw new Error("Invalid hostname");
  const app = options.app ?? createDefaultGateway(options);
  const deno = (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno;
  let boundPort: number;
  let close: () => Promise<void>;
  if (deno) {
    const server = deno.serve({ port, hostname, onListen() {} }, (request) => app.fetch(request));
    boundPort = server.addr.port;
    close = () => server.shutdown();
  } else {
    const { createAdaptorServer } = await import("@hono/node-server");
    const server = createAdaptorServer({ fetch: (request) => app.fetch(request) });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, hostname, () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener has no TCP address");
    boundPort = address.port;
    close = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  let closing: Promise<void> | undefined;
  return {
    runtime: deno ? "deno" : "node", hostname, port: boundPort,
    url: `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${boundPort}`,
    close: () => closing ??= close(),
  };
}
