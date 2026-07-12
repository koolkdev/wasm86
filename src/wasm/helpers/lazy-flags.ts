import { buildIrBlock, type SwitchArm } from "#ir/body-builder.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { IrBlock } from "#ir/block.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel, type StateSlot } from "#ir/slots.js";
import type { StateReadOp } from "#ir/ops.js";
import type { ValueId } from "#ir/values.js";
import { statusFlagValuesForSource } from "#x86/flag-values.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import type { OperandWidth } from "#x86/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import type { HelperRegistry } from "./registry.js";

export type LazyFlagHelper = X86StatusFlag;
export type HelperCallKey = Readonly<{ kind: "lazyFlag"; flag: X86StatusFlag }>;

export function lazyFlagHelperName(flag: LazyFlagHelper): string {
  return `resolve${flag}`;
}

export function defineLazyFlagHelper(registry: HelperRegistry<HelperCallKey>, flag: LazyFlagHelper): number {
  return registry.define({ kind: "lazyFlag", flag }, () => encodeLazyFlagHelperBody(flag));
}

export function defineLazyFlagHelpers(
  registry: HelperRegistry<HelperCallKey>,
  flags: Iterable<LazyFlagHelper>
): void {
  const required = new Set(flags);

  for (const flag of x86StatusFlags) {
    if (required.has(flag)) {
      defineLazyFlagHelper(registry, flag);
    }
  }
}

function encodeLazyFlagHelperBody(helper: LazyFlagHelper): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const resolver = lazyFlagResolverBlock(helper);

  scratch.withLocals([wasmValueType.i32], ([outputLocal]) => {
    emitActionFragment(resolver.block, {
      body,
      scratch,
      embedding: {
        fallthrough: { kind: "fallthrough" },
        outputs: new Map([[resolver.output, outputLocal]])
      }
    });
    body.localGet(outputLocal);
  });
  scratch.assertClear();
  return body.end();
}

// One IrBlock per helper: read the lazy kind channel, switch on it, export
// the selected arm's flag value. Each arm schedules its own channel reads,
// so demand stays arm-local — LOGIC arms never touch lazyFlagsB and a
// formula that ignores a read leaves it unemitted.
function lazyFlagResolverBlock(flag: LazyFlagHelper): Readonly<{ block: IrBlock; output: ValueId }> {
  let output!: ValueId;
  const block = buildIrBlock((b) => {
    output = b.switch(
      b.opValue({ kind: "state.read", slot: lazyFlagsKindChannel }),
      [
        noneArm(flag),
        ...([8, 16, 32] as const).flatMap((width) => [
          binaryArm(flag, "add", width),
          binaryArm(flag, "sub", width),
          logicArm(flag, width)
        ])
      ],
      (arm) => arm.values.unreachable()
    );
  });

  return { output, block };
}

function noneArm(flag: LazyFlagHelper): SwitchArm {
  return {
    match: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0),
    build: (arm) => arm.opValue({ kind: "state.read", slot: flagChannel(flag) })
  };
}

function binaryArm(flag: LazyFlagHelper, kind: "add" | "sub", width: OperandWidth): SwitchArm {
  return {
    match: lazyFlagsKindByte(
      kind === "add" ? WASM_CPU_LAZY_FLAGS_KIND.ADD : WASM_CPU_LAZY_FLAGS_KIND.SUB,
      width
    ),
    build: (arm) => {
      const left = arm.opValue(lazyOperandReadOp(lazyFlagsAChannel, width));
      const right = arm.opValue(lazyOperandReadOp(lazyFlagsBChannel, width));

      return statusFlagValuesForSource(valueTableFlagOps(arm.values), {
        kind,
        width,
        left,
        right,
        result: arm.values.binary(kind, left, right)
      }, { undefinedAF: arm.values.const(0) })[flag];
    }
  };
}

function logicArm(flag: LazyFlagHelper, width: OperandWidth): SwitchArm {
  return {
    match: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, width),
    build: (arm) => {
      const result = arm.opValue(lazyOperandReadOp(lazyFlagsAChannel, width));

      return statusFlagValuesForSource(valueTableFlagOps(arm.values), {
        kind: "logic",
        width,
        result
      }, { undefinedAF: arm.values.const(0) })[flag];
    }
  };
}

function lazyOperandReadOp(slot: StateSlot, width: OperandWidth): StateReadOp {
  return width === 32
    ? { kind: "state.read", slot }
    : { kind: "state.read", slot, accessByteLength: width === 8 ? 1 : 2 };
}
