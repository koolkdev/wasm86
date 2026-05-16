import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  type InstructionReusePlan,
  type SelectedValue
} from "#backends/wasm/jit/codegen/plan/reuse.js";
import type {
  Placement
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import {
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  LocalStore,
  type CachedValueLocal,
  type CachedValueUse
} from "./local-store.js";

export type {
  CachedValueHandle,
  CachedValueLocal,
  CachedValueUse
} from "./local-store.js";

export type ValueCache = Readonly<{
  beginInstruction(index: number): void;
  beginExpressionOp(opIndex: number): void;
  enterPath(path: Path): void;
  leavePath(): void;
  emitForUse(value: JitValue, emitter: () => ValueWidth): CachedValueUse;
  captureForReuse(
    value: JitValue,
    emitter: () => ValueWidth
  ): CachedValueLocal | undefined;
  canEmitInline(value: JitValue): boolean;
}>;

export function createValueCache(
  body: WasmFunctionBodyEncoder,
  plan: InstructionReusePlan | undefined
): ValueCache | undefined {
  if (plan === undefined || plan.cache.selected.length === 0) {
    return undefined;
  }

  const reusePlan = plan;
  const store = new LocalStore(body, reusePlan.cache.selected);
  let currentEpoch = 0;
  let currentInstructionIndex = 0;
  let currentOpIndex = 0;

  return {
    beginInstruction: (index) => {
      if (index < 0 || index >= reusePlan.instructions.length) {
        throw new Error(`JIT value cache instruction index out of range: ${index}`);
      }

      currentInstructionIndex = index;
      currentOpIndex = 0;
      currentEpoch = currentInstructionPlan().opEpochs[0] ?? currentEpoch;
    },
    beginExpressionOp: (opIndex) => {
      const instructionPlan = currentInstructionPlan();

      if (opIndex < 0 || opIndex >= instructionPlan.opEpochs.length) {
        throw new Error(`JIT value cache expression op index out of range: ${opIndex}`);
      }

      currentOpIndex = opIndex;
      currentEpoch = instructionPlan.opEpochs[opIndex] ?? currentEpoch;
    },
    emitForUse: (value, emitter) => {
      if (valueIsConsumerAtCurrentEpoch(value)) {
        return store.emitForUseWithLocal(value, emitter);
      }

      return store.emitAvailableForUse(value) ?? { valueWidth: emitter() };
    },
    captureForReuse: (value, emitter) =>
      valueIsConsumerAtCurrentEpoch(value) || valueHasCaptureAtCurrentPlacement(value)
        ? store.captureForReuse(value, emitter)
        : store.captureAvailableForReuse(value),
    canEmitInline: (value) => !valueIsConsumerAtCurrentEpoch(value),
    enterPath: (path) => {
      store.enterPath(path);
    },
    leavePath: () => {
      store.leavePath();
    }
  };

  function valueIsConsumerAtCurrentEpoch(value: JitValue): boolean {
    return valueIsSelected(currentEpochPlan()?.consumers ?? [], value);
  }

  function valueHasCaptureAtCurrentPlacement(value: JitValue): boolean {
    const placement = currentPlacement();

    return reusePlan.captures.captures.some((capture) =>
      placementsEqual(capture.at, placement) &&
        valuesEqual(simplifyValue(capture.value), simplifyValue(value))
    );
  }

  function currentEpochPlan() {
    return reusePlan.cache.epochs[currentEpoch];
  }

  function currentInstructionPlan() {
    const instructionPlan = reusePlan.instructions[currentInstructionIndex];

    if (instructionPlan === undefined) {
      throw new Error(`missing JIT value cache instruction plan: ${currentInstructionIndex}`);
    }

    return instructionPlan;
  }

  function currentPlacement(): Placement {
    return {
      instructionIndex: currentInstructionIndex,
      opIndex: currentOpIndex,
      epoch: currentEpoch
    };
  }
}

function valueIsSelected(selected: readonly SelectedValue[], value: JitValue): boolean {
  const simplified = simplifyValue(value);

  return selected.some((entry) => valuesEqual(simplifyValue(entry.value), simplified));
}

function placementsEqual(left: Placement, right: Placement): boolean {
  return left.instructionIndex === right.instructionIndex &&
    left.opIndex === right.opIndex &&
    left.epoch === right.epoch;
}
