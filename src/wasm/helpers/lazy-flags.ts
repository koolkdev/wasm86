import { assert } from "#common/assert.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { IrBlock } from "#ir/block.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel, type LazyFlagsChannel } from "#ir/slots.js";
import { ValueTable, type ValueId, type HelperCallKey } from "#ir/values.js";
import { statusFlagValuesForSource } from "#x86/flag-values.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import type { OperandWidth } from "#x86/types.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import { emitActionFragment } from "#wasm/emit/emit.js";
import { emitSlotLoad } from "#wasm/emit/state.js";
import type { HelperRegistry } from "./registry.js";

export type LazyFlagHelper = X86StatusFlag;

export function lazyFlagHelperKey(flag: LazyFlagHelper): HelperCallKey {
  return { kind: "lazyFlag", flag };
}

export function lazyFlagHelperName(flag: LazyFlagHelper): string {
  return `resolve${flag}`;
}

export function defineLazyFlagHelper(registry: HelperRegistry<HelperCallKey>, flag: LazyFlagHelper): number {
  return registry.define(lazyFlagHelperKey(flag), () => encodeLazyFlagHelperBody(flag));
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
  const kindLocal = body.addLocal(wasmValueType.i32);

  emitLazyFieldLoad(body, helper, lazyFlagsKindChannel);
  body.localSet(kindLocal);

  emitResolverCase(body, kindLocal, lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0), () => {
    emitSlotLoad(body, flagChannel(helper), false, (id) => {
      assert(false, `${lazyFlagHelperName(helper)} unexpectedly needed value operand ${id}`);
    });
  });

  for (const width of [8, 16, 32] as const) {
    emitResolverCase(body, kindLocal, lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.ADD, width), () => {
      emitBinaryFlag(body, scratch, helper, "add", width);
    });
    emitResolverCase(body, kindLocal, lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, width), () => {
      emitBinaryFlag(body, scratch, helper, "sub", width);
    });
  }

  body.unreachable();
  scratch.assertClear();
  return body.end();
}

function emitResolverCase(
  body: WasmFunctionBodyEncoder,
  kindLocal: number,
  expected: number,
  emitValue: () => void
): void {
  body.localGet(kindLocal).i32Const(expected).i32Eq();
  body.ifBlock();
  emitValue();
  body.returnFromFunction();
  body.endBlock();
}

function emitBinaryFlag(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator,
  flag: LazyFlagHelper,
  kind: "add" | "sub",
  width: OperandWidth
): void {
  const fragment = binaryFlagFragment(flag, kind, width);

  scratch.withLocals([wasmValueType.i32], ([outputLocal]) => {
    emitActionFragment(fragment.block, {
      body,
      scratch,
      embedding: {
        completion: { kind: "fallthrough" },
        outputs: new Map([[fragment.value, outputLocal]])
      }
    });
    body.localGet(outputLocal);
  });
}

function emitLazyFieldLoad(
  body: WasmFunctionBodyEncoder,
  helper: LazyFlagHelper,
  channel: LazyFlagsChannel
): void {
  emitSlotLoad(body, channel, false, (id: ValueId) => {
    assert(false, `${lazyFlagHelperName(helper)} unexpectedly needed value operand ${id}`);
  });
}

function binaryFlagFragment(
  flag: LazyFlagHelper,
  kind: "add" | "sub",
  width: OperandWidth
): Readonly<{ block: IrBlock; value: ValueId }> {
  const values = new ValueTable();
  const left = values.addActionOutput();
  const right = values.addActionOutput();
  const result = values.internBinary(kind, left, right);
  const formula = statusFlagValuesForSource(valueTableFlagOps(values), {
    kind,
    width,
    left,
    right,
    result
  }, { undefinedAF: values.internConst(0) })[flag];

  return {
    value: formula,
    block: {
      entry: 0,
      regions: [
        {
          id: 0,
          kind: "entry",
          actions: [
            { kind: "readState", output: left, slot: lazyFlagsAChannel },
            { kind: "readState", output: right, slot: lazyFlagsBChannel },
            { kind: "continue" }
          ]
        }
      ],
      values
    }
  };
}
