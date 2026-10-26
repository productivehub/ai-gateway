export class BridgeError extends Error {
  override readonly name: string = "BridgeError";
}

/** A native feature cannot be represented faithfully by the target API. */
export class UnsupportedFeatureError extends BridgeError {
  override readonly name = "UnsupportedFeatureError";
  constructor(readonly target: string, readonly feature: string) {
    super(`Cannot convert ${feature} to ${target}`);
  }
}

export class UnknownProviderError extends BridgeError {
  override readonly name = "UnknownProviderError";
  constructor(readonly provider: string) {
    super(`No adapter registered for provider "${provider}"`);
  }
}

export class UnknownDialectError extends BridgeError {
  override readonly name = "UnknownDialectError";
  constructor(readonly dialect: string) {
    super(`No dialect registered for "${dialect}"`);
  }
}
