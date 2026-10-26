# Getting Started

## Set up a checkout

Use Node.js 22 or later and the pnpm version declared in `package.json`.

```sh
git clone https://github.com/productivehub/ai-bridge.git
cd ai-bridge
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Inside phub-director, run installation from the monorepo root. A workspace consumer can declare `"@productivehub/ai-bridge": "workspace:*"` as a dependency. The examples below assume the package is available to your application.

## Make a completion

This example uses a local Ollama server. Start that server and install the model you intend to call before running the example. Setting its URL explicitly enables the adapter.

```ts
import {
  createBridge,
  createBuiltInProviders,
  anthropicDialect,
  openaiDialect,
} from "@productivehub/ai-bridge";

const bridge = createBridge({
  providers: createBuiltInProviders({
    ollama: { baseURL: "http://localhost:11434" },
  }, {}),
  dialects: {
    anthropic: anthropicDialect,
    openai: openaiDialect,
  },
});

const response = await bridge.complete({
  provider: "ollama",
  model: "llama3.2",
  input: {
    messages: [{ role: "user", content: "Explain what an AI bridge does." }],
    maxOutputTokens: 256,
  },
});

console.log(response.output.choices);
console.log(response.usage);
console.log(response.meta);
const anthropicResponse = response.toDialect("anthropic");
const openaiResponse = response.toDialect("openai");
```

The second factory argument is the environment to read. Passing `{}` makes this example use only the explicitly configured connection. Omit it to use the process environment as well.

`provider` selects the registered adapter, and `model` is the identifier accepted by that provider. The bridge does not translate model names into another provider's model names.

Use [Model Discovery](./Model-Discovery.md) to find available identifiers, [Configuration](./Configuration.md) to configure hosted providers, and [Dialects](./Dialects.md) to understand conversion limits.
