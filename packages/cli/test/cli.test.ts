import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@productivehub/ai-gateway-api";
import { runCli, type CliIO } from "../src/cli.js";
import type { GatewayListener } from "@productivehub/ai-gateway-api/listener";
import { fixture } from "./helpers.js";

function run(argv: string[], io: CliIO = {}) {
  const { bridge, complete } = fixture();
  let stdout = "";
  let stderr = "";
  const app = createGateway({ bridge, defaultProvider: "test", models: { writer: { key: "second", model: "native-writer" } }, env: {} });
  const result = runCli(argv, {
    app, env: {}, stdin: Object.assign((async function* () {})(), { isTTY: true }),
    stdout: { write: (text: string) => { stdout += text; } },
    stderr: { write: (text: string) => { stderr += text; } },
    ...io,
  });
  return result.then((code) => ({ code, stdout, stderr, complete }));
}

const stdin = (text: string): NonNullable<CliIO["stdin"]> => Object.assign((async function* () { yield new TextEncoder().encode(text); })(), { isTTY: false });

describe("complete", () => {
  it("prints the reply text for the bridge dialect", async () => {
    const { code, stdout, complete } = await run(["complete", "org/model:latest", "Hello", "there", "-s", "Be brief", "--max-tokens", "64"]);
    expect(code).toBe(0);
    expect(stdout).toBe("Hello back\n");
    expect(complete).toHaveBeenCalledWith({
      model: "org/model:latest",
      input: { messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hello there" }], maxOutputTokens: 64 },
    });
  });

  it("reads the prompt from stdin when no prompt arguments are given", async () => {
    const { code, complete } = await run(["complete", "model"], { stdin: stdin("from a pipe\n") });
    expect(code).toBe(0);
    expect(complete.mock.calls[0]?.[0].input.messages).toEqual([{ role: "user", content: "from a pipe" }]);
  });

  it("prints dialect output and full envelopes as JSON", async () => {
    const dialect = await run(["complete", "model", "hi", "--dialect", "mine"]);
    expect(JSON.parse(dialect.stdout)).toEqual({ answer: "Hello back" });
    const envelope = await run(["complete", "writer", "hi", "--json"]);
    expect(JSON.parse(envelope.stdout)).toMatchObject({ key: "second", model: "native-writer", dialect: "bridge", usage: { totalTokens: 5 } });
  });

  it("sends BridgeInput from a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-gateway-"));
    const file = join(dir, "input.json");
    await writeFile(file, JSON.stringify({ messages: [{ role: "user", content: "file" }], temperature: 1 }));
    const { code, complete } = await run(["complete", "model", "--input", file, "--temperature", "0.2"]);
    expect(code).toBe(0);
    expect(complete.mock.calls[0]?.[0].input).toEqual({ messages: [{ role: "user", content: "file" }], temperature: 0.2 });
  });

  it("reports usage and HTTP errors with distinct exit codes", async () => {
    expect(await run(["complete", "model"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Supply a prompt") });
    expect(await run(["complete", "model", "hi", "--max-tokens", "lots"])).toMatchObject({ code: 2, stderr: expect.stringContaining("--max-tokens") });
    expect(await run(["complete", "model", "hi", "--bogus"])).toMatchObject({ code: 2 });
    expect(await run(["complete", "model", "hi", "--key", "missing"])).toMatchObject({ code: 1, stderr: "ai-gateway: Unknown key (HTTP 400)\n" });
  });
});

describe("discovery", () => {
  it("lists keys and configured aliases as tab-separated rows", async () => {
    expect((await run(["keys"])).stdout).toBe("test\ttest\nsecond\tsecond\n");
    expect((await run(["models", "--configured"])).stdout).toBe("writer\tsecond\tsecond\tnative-writer\n");
  });

  it("surfaces provider discovery errors", async () => {
    const { code, stderr } = await run(["models", "--key", "test"]);
    expect(code).toBe(1);
    expect(stderr).toContain("HTTP 422");
  });
});

describe("remote", () => {
  it("sends the same requests to --url with the injected fetch", async () => {
    const fetch = vi.fn(async () => Response.json({ keys: [{ name: "work", provider: "anthropic", endpoints: {} }] }));
    const { stdout } = await run(["keys", "--url", "http://host:3000/api/ai/"], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe("http://host:3000/api/ai/keys");
    expect(stdout).toBe("work\tanthropic\n");
  });

  it("rejects --config with --url", async () => {
    expect(await run(["keys", "--url", "http://host", "--config", "x.json"])).toMatchObject({ code: 2 });
  });
});

describe("serve", () => {
  it("listens until the signal aborts", async () => {
    const controller = new AbortController();
    let listener: GatewayListener | undefined;
    const served = run(["serve", "--port", "0"], {
      signal: controller.signal,
      onListen: async (opened) => {
        listener = opened;
        expect((await fetch(`${opened.url}/health`)).status).toBe(200);
        controller.abort();
      },
    });
    const { code, stdout } = await served;
    expect(code).toBe(0);
    expect(stdout).toContain(`listening on ${listener!.url}`);
    await expect(fetch(`${listener!.url}/health`)).rejects.toThrow();
  });
});

it("prints help and rejects unknown commands", async () => {
  expect(await run(["--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ai-gateway") });
  expect(await run([])).toMatchObject({ code: 2 });
  expect(await run(["launch"])).toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown command "launch"') });
});
