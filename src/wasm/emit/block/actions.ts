import { assert } from "#common/assert.js";
import type { BlockExit } from "#ir/block/exits.js";
import type { RegisterStateTarget } from "#ir/block/state/targets.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  emitGuardGuestMemoryRange,
  emitStoreGuestMemoryFromStackUnchecked
} from "../ops/memory.js";
import type { WasmTargetStorage } from "../targets/storage.js";
import { emitStoreDynamicRegister } from "./dynamic-registers.js";
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
  exitRegions: WasmExitRegionContext;
  registers: WasmTargetStorage<RegisterStateTarget>;
}>;

export function createWasmActionEmitter(input: WasmActionEmitterInput): WasmActionEmitter {
  return new WasmActionEmitterState(input);
}

class WasmActionEmitterState implements WasmActionEmitter {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #exitRegions: WasmExitRegionContext;
  readonly #registers: WasmTargetStorage<RegisterStateTarget>;

  constructor(input: WasmActionEmitterInput) {
    this.#body = input.body;
    this.#exitRegions = input.exitRegions;
    this.#registers = input.registers;
  }

  emitActionInputs(input: WasmActionInputsEmitInput): void {
    switch (input.site.action.kind) {
      case "memoryGuard":
        input.operands.emitLocal("address");
        return;
      case "memoryStore":
        input.operands.emitStack("address");
        input.operands.emitStack("value");
        return;
      case "dynamicRegisterStore":
        input.operands.emitLocal("value");
        return;
      case "branch":
        input.operands.emitStack("condition");
        return;
      case "jump":
      case "hostTrap":
      case "fallthrough":
        return;
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
        this.#emitDynamicRegisterStore(input);
        return;
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

    const fault = edgeForExit(input, action.faultExit);
    const address = input.operands.local("address");

    this.#exitRegions.withControlDepth(1, () => {
      emitGuardGuestMemoryRange(this.#body, address.local, action.byteLength, () => {
        this.#emitEdgeRegion(input, fault);
      });
    });
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

  #emitDynamicRegisterStore(input: WasmActionEffectEmitInput): void {
    assert(input.site.action.kind === "dynamicRegisterStore", "expected dynamicRegisterStore action");

    emitStoreDynamicRegister(
      this.#body,
      input.site.action.width,
      () => {
        input.operands.emitStack("index");
      },
      input.operands.local("value"),
      this.#registers
    );
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
