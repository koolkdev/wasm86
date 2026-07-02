import { assert } from "#common/assert.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { IrBlock } from "#ir/block.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel } from "#ir/slots.js";
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

type ResolverCase = Readonly<{
  kindByte: number;
  emitValue: () => void;
}>;

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

  emitSlotLoad(body, lazyFlagsKindChannel, false);
  body.localSet(kindLocal);

  const cases = resolverCases(body, scratch, helper);

  for (let index = 0; index <= cases.length; index += 1) {
    body.block();
  }

  body.localGet(kindLocal).brTable(lazyKindDispatchTable(cases), cases.length);

  for (let index = cases.length - 1; index >= 0; index -= 1) {
    body.endBlock();
    cases[index]!.emitValue();
    body.returnFromFunction();
  }

  body.endBlock();
  body.unreachable();
  scratch.assertClear();
  return body.end();
}

function resolverCases(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator,
  helper: LazyFlagHelper
): readonly ResolverCase[] {
  return [
    {
      kindByte: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0),
      emitValue: () => {
        emitSlotLoad(body, flagChannel(helper), false);
      }
    },
    ...([8, 16, 32] as const).flatMap((width) => [
      {
        kindByte: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.ADD, width),
        emitValue: () => emitBinaryFlag(body, scratch, helper, "add", width)
      },
      {
        kindByte: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, width),
        emitValue: () => emitBinaryFlag(body, scratch, helper, "sub", width)
      },
      {
        kindByte: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, width),
        emitValue: () => emitLogicFlag(body, scratch, helper, width)
      }
    ])
  ];
}

function lazyKindDispatchTable(cases: readonly ResolverCase[]): number[] {
  const maxKindByte = Math.max(...cases.map((entry) => entry.kindByte));
  const table = new Array<number>(maxKindByte + 1).fill(cases.length);

  for (const [index, entry] of cases.entries()) {
    assert(table[entry.kindByte] === cases.length, `duplicate lazy flag kind byte ${entry.kindByte}`);
    table[entry.kindByte] = cases.length - 1 - index;
  }

  return table;
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
        fallthrough: { kind: "fallthrough" },
        outputs: new Map([[fragment.value, outputLocal]])
      }
    });
    body.localGet(outputLocal);
  });
}

function emitLogicFlag(
  body: WasmFunctionBodyEncoder,
  scratch: WasmLocalScratchAllocator,
  flag: LazyFlagHelper,
  width: OperandWidth
): void {
  const fragment = logicFlagFragment(flag, width);

  scratch.withLocals([wasmValueType.i32], ([outputLocal]) => {
    emitActionFragment(fragment.block, {
      body,
      scratch,
      embedding: {
        fallthrough: { kind: "fallthrough" },
        outputs: new Map([[fragment.value, outputLocal]])
      }
    });
    body.localGet(outputLocal);
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
  const result = values.binary(kind, left, right);
  const formula = statusFlagValuesForSource(valueTableFlagOps(values), {
    kind,
    width,
    left,
    right,
    result
  }, { undefinedAF: values.const(0) })[flag];

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
            { kind: "readState", output: right, slot: lazyFlagsBChannel }
          ]
        }
      ],
      values
    }
  };
}

function logicFlagFragment(
  flag: LazyFlagHelper,
  width: OperandWidth
): Readonly<{ block: IrBlock; value: ValueId }> {
  const values = new ValueTable();
  const result = values.addActionOutput();
  const formula = statusFlagValuesForSource(valueTableFlagOps(values), {
    kind: "logic",
    width,
    result
  }, { undefinedAF: values.const(0) })[flag];

  return {
    value: formula,
    block: {
      entry: 0,
      regions: [
        {
          id: 0,
          kind: "entry",
          actions: [
            { kind: "readState", output: result, slot: lazyFlagsAChannel }
          ]
        }
      ],
      values
    }
  };
}
