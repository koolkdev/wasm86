import { createOpAction, type SwitchCase } from "#ir/actions.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { IrBlock } from "#ir/block.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel, type StateSlot } from "#ir/slots.js";
import type { StateReadOp } from "#ir/ops.js";
import { fitsUnsigned, ValueTable, type ValueId } from "#ir/values.js";
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
  const values = new ValueTable();
  const kindRead = createOpAction(values, { kind: "state.read", slot: lazyFlagsKindChannel });
  const cases: SwitchCase[] = [
    noneArm(values, flag),
    ...([8, 16, 32] as const).flatMap((width) => [
      binaryArm(values, flag, "add", width),
      binaryArm(values, flag, "sub", width),
      logicArm(values, flag, width)
    ])
  ];
  // Every arm result exists before the output: placement's descending walk
  // settles the output's demand before charging them.
  const defaultBody = { actions: [], result: values.unreachable() };
  const output = values.addActionOutput(fitsUnsigned(1));

  return {
    output,
    block: {
      values,
      body: {
        actions: [
          kindRead,
          {
            kind: "switch",
            selector: kindRead.output!,
            output,
            cases,
            defaultBody
          }
        ]
      }
    }
  };
}

function noneArm(values: ValueTable, flag: LazyFlagHelper): SwitchCase {
  const read = createOpAction(values, { kind: "state.read", slot: flagChannel(flag) });

  return {
    match: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0),
    body: { actions: [read], result: read.output! }
  };
}

function binaryArm(
  values: ValueTable,
  flag: LazyFlagHelper,
  kind: "add" | "sub",
  width: OperandWidth
): SwitchCase {
  const left = createOpAction(values, lazyOperandReadOp(lazyFlagsAChannel, width));
  const right = createOpAction(values, lazyOperandReadOp(lazyFlagsBChannel, width));
  const formula = statusFlagValuesForSource(valueTableFlagOps(values), {
    kind,
    width,
    left: left.output!,
    right: right.output!,
    result: values.binary(kind, left.output!, right.output!)
  }, { undefinedAF: values.const(0) })[flag];

  return {
    match: lazyFlagsKindByte(
      kind === "add" ? WASM_CPU_LAZY_FLAGS_KIND.ADD : WASM_CPU_LAZY_FLAGS_KIND.SUB,
      width
    ),
    body: { actions: [left, right], result: formula }
  };
}

function logicArm(values: ValueTable, flag: LazyFlagHelper, width: OperandWidth): SwitchCase {
  const result = createOpAction(values, lazyOperandReadOp(lazyFlagsAChannel, width));
  const formula = statusFlagValuesForSource(valueTableFlagOps(values), {
    kind: "logic",
    width,
    result: result.output!
  }, { undefinedAF: values.const(0) })[flag];

  return {
    match: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, width),
    body: { actions: [result], result: formula }
  };
}

function lazyOperandReadOp(slot: StateSlot, width: OperandWidth): StateReadOp {
  return width === 32
    ? { kind: "state.read", slot }
    : { kind: "state.read", slot, accessByteLength: width === 8 ? 1 : 2 };
}
