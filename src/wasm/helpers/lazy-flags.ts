import { buildIrBlock, type SwitchArm } from "#ir/body-builder.js";
import { stateRead, type StateReadArgs } from "#compiler/ir/operations/state.js";
import { valueTableFlagOps } from "#ir/flag-value-ops.js";
import type { IrBlock } from "#ir/block.js";
import { flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel, type StateSlot } from "#ir/slots.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { statusFlagValuesForSource } from "#core/flags/values.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/state.js";
import type { X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/action.js";

// A raw encoded body factory for the temporary declared-helper compatibility
// path. It owns no module insertion or numeric function binding.
export function encodeLazyFlagHelperBody(helper: X86StatusFlag): EncodedWasmFunctionBody {
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
  return body.finish();
}

// One IrBlock per helper: read the lazy kind channel, switch on it, export
// the selected arm's flag value. Each arm places its own channel reads,
// so demand stays arm-local — LOGIC arms never touch lazyFlagsB and a
// formula that ignores a read leaves it unemitted.
function lazyFlagResolverBlock(flag: X86StatusFlag): Readonly<{ block: IrBlock; output: ValueId }> {
  let output!: ValueId;
  const block = buildIrBlock((b) => {
    output = b.switch(
      b.operation(stateRead.create({ slot: lazyFlagsKindChannel })),
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

function noneArm(flag: X86StatusFlag): SwitchArm {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0),
    build: (arm) => arm.operation(stateRead.create({ slot: flagChannel(flag) }))
  };
}

function binaryArm(flag: X86StatusFlag, kind: "add" | "sub", width: OperandWidth): SwitchArm {
  return {
    match: lazyFlagsKindByte(
      kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB,
      width
    ),
    build: (arm) => {
      const left = arm.operation(
        stateRead.create(lazyOperandReadArgs(lazyFlagsAChannel, width))
      );
      const right = arm.operation(
        stateRead.create(lazyOperandReadArgs(lazyFlagsBChannel, width))
      );

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

function logicArm(flag: X86StatusFlag, width: OperandWidth): SwitchArm {
  return {
    match: lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, width),
    build: (arm) => {
      const result = arm.operation(
        stateRead.create(lazyOperandReadArgs(lazyFlagsAChannel, width))
      );

      return statusFlagValuesForSource(valueTableFlagOps(arm.values), {
        kind: "logic",
        width,
        result
      }, { undefinedAF: arm.values.const(0) })[flag];
    }
  };
}

function lazyOperandReadArgs(slot: StateSlot, width: OperandWidth): StateReadArgs {
  return width === 32
    ? { slot }
    : { slot, accessByteLength: width === 8 ? 1 : 2 };
}
