export class UnsupportedWasmCodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWasmCodegenError";
  }
}

export function unsupportedWasmCodegen(message: string): never {
  throw new UnsupportedWasmCodegenError(message);
}
