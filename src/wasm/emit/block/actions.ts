import { assert } from "#common/assert.js";
import type { BlockExit } from "#ir/block/exits.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import {
  emitGuardGuestMemoryRange,
  emitStoreGuestMemoryFromStackUnchecked
} from "../ops/memory.js";
import type {
  WasmActionEffectEmitInput,
  WasmActionEmitter,
  WasmActionInputsEmitInput,
  WasmLayoutActionEdge
} from "./types.js";
import type {
  WasmExitRegionContext,
  WasmExitRegionPayload
} from "./exits.js";

export type WasmActionEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  exitRegions: WasmExitRegionContext;
}>;

export function createWasmActionEmitter(input: WasmActionEmitterInput): WasmActionEmitter {
  return new WasmActionEmitterState(input);
}

class WasmActionEmitterState implements WasmActionEmitter {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #scratch: WasmLocalScratchAllocator;
  readonly #exitRegions: WasmExitRegionContext;

  constructor(input: WasmActionEmitterInput) {
    this.#body = input.body;
    this.#scratch = input.scratch;
    this.#exitRegions = input.exitRegions;
  }

  emitActionInputs(input: WasmActionInputsEmitInput): void {
    for (const layoutInput of input.inputs) {
      input.emitInput(layoutInput);
    }
  }

  emitActionEffect(input: WasmActionEffectEmitInput): void {
    switch (input.site.action.kind) {
      case "memoryGuard":
        this.#emitMemoryGuard(input);
        return;
      case "memoryStore":
        emitStoreGuestMemoryFromStackUnchecked(this.#body, input.site.action.width);
        return;
      case "dynamicRegisterStore":
        throw new Error("Wasm dynamicRegisterStore action lowering is unsupported");
      case "jump":
      case "hostTrap":
      case "fallthrough": {
        const edge = edgeForExit(input, input.site.action.exit);

        this.#emitEdgeRegion(input, edge);
        return;
      }
      case "branch":
        this.#emitBranch(input);
        return;
    }
  }

  #emitMemoryGuard(input: WasmActionEffectEmitInput): void {
    const action = input.site.action;

    assert(action.kind === "memoryGuard", "expected memoryGuard action");

    const addressLocal = this.#scratch.allocLocal(wasmValueType.i32);
    const fault = edgeForExit(input, action.faultExit);

    try {
      this.#body.localSet(addressLocal);
      this.#exitRegions.withControlDepth(1, () => {
        emitGuardGuestMemoryRange(this.#body, addressLocal, action.byteLength, () => {
          this.#emitEdgeRegion(input, fault);
        });
      });
    } finally {
      this.#scratch.freeLocal(addressLocal);
    }
  }

  #emitBranch(input: WasmActionEffectEmitInput): void {
    assert(input.site.action.kind === "branch", "expected branch action");

    const taken = edgeForExit(input, input.site.action.taken);
    const notTaken = edgeForExit(input, input.site.action.notTaken);

    this.#exitRegions.withControlDepth(1, () => {
      this.#body.ifBlock();
      this.#emitEdgeRegion(input, taken);
      this.#body.elseBlock();
      this.#emitEdgeRegion(input, notTaken);
      this.#body.endBlock();
    });
  }

  #emitEdgeRegion(
    input: WasmActionEffectEmitInput,
    edge: WasmLayoutActionEdge
  ): void {
    const payload = exitRegionPayload(edge);

    this.#exitRegions.withExitRegion(edge.exit, payload, () => input.emitEdge(edge));
  }
}

function exitRegionPayload(edge: WasmLayoutActionEdge): WasmExitRegionPayload {
  switch (edge.exitPayload.kind) {
    case "none":
      return { kind: "constant", value: 0 };
    case "input":
      return { kind: "stack" };
  }
}

function edgeForExit(
  input: WasmActionEffectEmitInput,
  exit: BlockExit
): WasmLayoutActionEdge {
  const edge = input.edges.find((candidate) => candidate.exit === exit);

  assert(edge !== undefined, `layout action has no edge for block exit ${exit.id}`);
  return edge;
}
