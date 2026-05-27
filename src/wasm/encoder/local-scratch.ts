import { WasmFunctionBodyEncoder } from "./function-body.js";
import type { WasmValueType } from "./types.js";

export type ScratchLocals<Types extends readonly WasmValueType[]> = {
  readonly [Index in keyof Types]: number;
};

export class WasmLocalScratchAllocator {
  readonly #scratchLocalTypes = new Map<number, WasmValueType>();
  readonly #freeScratchLocals = new Map<WasmValueType, number[]>();

  constructor(readonly body: WasmFunctionBodyEncoder) {}

  allocLocal(type: WasmValueType): number {
    const freeLocals = this.#freeScratchLocals.get(type);
    const reusable = freeLocals?.pop();

    if (reusable !== undefined) {
      return reusable;
    }

    const index = this.body.addLocal(type);

    this.#scratchLocalTypes.set(index, type);
    return index;
  }

  freeLocal(index: number): void {
    const type = this.#scratchLocalTypes.get(index);

    if (type === undefined) {
      throw new Error(`cannot free non-scratch local: ${index}`);
    }

    const freeLocals = scratchLocalList(this.#freeScratchLocals, type);

    if (freeLocals.includes(index)) {
      throw new Error(`scratch local already free: ${index}`);
    }

    freeLocals.push(index);
  }

  assertClear(): void {
    const freeLocals = new Set<number>();

    for (const locals of this.#freeScratchLocals.values()) {
      for (const local of locals) {
        freeLocals.add(local);
      }
    }

    const inUseLocals = Array.from(this.#scratchLocalTypes.keys())
      .filter((local) => !freeLocals.has(local));

    if (inUseLocals.length !== 0) {
      throw new Error(`scratch locals still in use: ${inUseLocals.join(", ")}`);
    }
  }

  withLocals<const Types extends readonly WasmValueType[], Result>(
    types: Types,
    callback: (locals: ScratchLocals<Types>) => Result
  ): Result {
    const locals = types.map((type) => this.allocLocal(type)) as ScratchLocals<Types>;

    try {
      return callback(locals);
    } finally {
      for (const local of Array.from(locals).reverse()) {
        this.freeLocal(local);
      }
    }
  }
}

function scratchLocalList(
  freeScratchLocals: Map<WasmValueType, number[]>,
  type: WasmValueType
): number[] {
  let locals = freeScratchLocals.get(type);

  if (locals === undefined) {
    locals = [];
    freeScratchLocals.set(type, locals);
  }

  return locals;
}
