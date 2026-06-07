import { assert } from "#common/assert.js";
import type { ExprInputSource } from "#ir/expr/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { RegisterAlias } from "#x86/types.js";
import { emitLoadPackedFlagFromStack } from "../ops/flags.js";
import { emitLoadStateI32 } from "../ops/state.js";
import type { WasmStateI32Placement } from "../state/placement.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "../values/types.js";

export type WasmReadableInputSource = Exclude<ExprInputSource, Readonly<{ kind: "def" }>>;

export type WasmSourceReadPlacement =
  | Readonly<{
      kind: "local.i32";
      local: number;
    }>
  | Readonly<{
      kind: "state.i32";
      state: WasmStateI32Placement;
    }>
  | Readonly<{
      kind: "packed-flag-local";
      local: number;
    }>
  | Readonly<{
      kind: "packed-flag-state";
      state: WasmStateI32Placement;
    }>;

export type WasmSourceReadPlan = Readonly<{
  placement(source: WasmReadableInputSource): WasmSourceReadPlacement;
}>;

export type WasmRegisterAliasInputReadOptions = Readonly<{
  signed?: boolean;
}>;

export type WasmSourceReader = Readonly<{
  emitInput(source: WasmReadableInputSource): WasmEmittedValue;
  tryEmitRegisterAliasInput(
    alias: RegisterAlias,
    options?: WasmRegisterAliasInputReadOptions
  ): WasmEmittedValue | undefined;
}>;

export function createWasmSourceReader(
  body: WasmFunctionBodyEncoder,
  plan: WasmSourceReadPlan
): WasmSourceReader {
  const emitInput = (source: WasmReadableInputSource): WasmEmittedValue => {
    const placement = plan.placement(source);

    assertSourceReadPlacement(source, placement);
    return emitSourceInput(body, source, placement);
  };
  const tryEmitRegisterAliasInput = (
    alias: RegisterAlias,
    options: WasmRegisterAliasInputReadOptions = {}
  ): WasmEmittedValue | undefined => {
    if (alias.width === 32) {
      return emitInput({ kind: "reg", reg: alias.base });
    }

    const source = { kind: "reg", reg: alias.base } as const;
    const placement = plan.placement(source);

    assertSourceReadPlacement(source, placement);

    if (placement.kind !== "state.i32") {
      return undefined;
    }

    assert(
      alias.bitOffset % 8 === 0,
      `state-memory register ${alias.name} has non-byte bit offset ${alias.bitOffset}`
    );

    return emitLoadStateI32(
      body,
      placement.state.offset + alias.bitOffset / 8,
      alias.width,
      options.signed === true
    );
  };

  return {
    emitInput,
    tryEmitRegisterAliasInput
  };
}

function assertSourceReadPlacement(
  source: WasmReadableInputSource,
  placement: WasmSourceReadPlacement
): void {
  switch (source.kind) {
    case "reg":
      switch (placement.kind) {
        case "local.i32":
          return;
        case "state.i32":
          assert(
            placement.state.width === 32,
            `register input ${source.reg} must use a 32-bit state placement, ` +
            `got ${placement.state.width}-bit state placement`
          );
          return;
        case "packed-flag-local":
        case "packed-flag-state":
          assert(false, `register input ${source.reg} cannot use packed flag placement ${placement.kind}`);
      }
      return;
    case "flag":
      switch (placement.kind) {
        case "packed-flag-local":
          return;
        case "packed-flag-state":
          return;
        case "local.i32":
        case "state.i32":
          assert(false, `flag input ${source.flag} must use a packed flag placement, got ${placement.kind}`);
      }
      return;
  }
}

function emitSourceInput(
  body: WasmFunctionBodyEncoder,
  source: WasmReadableInputSource,
  placement: WasmSourceReadPlacement
): WasmEmittedValue {
  switch (placement.kind) {
    case "local.i32":
      body.localGet(placement.local);
      return wasmI32(32);
    case "state.i32":
      return emitLoadStateI32(body, placement.state.offset, placement.state.width);
    case "packed-flag-local": {
      assert(source.kind === "flag", `packed flag source placement cannot read ${source.kind} input`);

      body.localGet(placement.local);
      return emitLoadPackedFlag(body, source);
    }
    case "packed-flag-state": {
      assert(source.kind === "flag", `packed flag source placement cannot read ${source.kind} input`);

      emitLoadStateI32(body, placement.state.offset, placement.state.width);
      return emitLoadPackedFlag(body, source);
    }
  }
}

function emitLoadPackedFlag(
  body: WasmFunctionBodyEncoder,
  source: Extract<WasmReadableInputSource, Readonly<{ kind: "flag" }>>
): WasmEmittedValue {
  return emitLoadPackedFlagFromStack(body, source.flag);
}
