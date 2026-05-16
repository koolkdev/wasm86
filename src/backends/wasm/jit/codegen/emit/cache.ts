import type { ValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import {
  type CachePlan,
  type CapturePlan,
  type InstructionEpochs,
  type SelectedValue
} from "#backends/wasm/jit/codegen/plan/reuse.js";
import type {
  Placement
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import {
  pathsEqual,
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  LocalStore,
  type CapturedValue,
  type CachedUse
} from "./local-store.js";

export type {
  CachedHandle,
  CapturedValue,
  CachedUse
} from "./local-store.js";

export type ValueCache = Readonly<{
  beginInstruction(index: number): void;
  beginOp(opIndex: number): void;
  enterPath(path: Path): void;
  leavePath(): void;
  emitForUse(value: JitValue, emitter: () => ValueWidth): CachedUse;
  capture(
    value: JitValue,
    emitter: () => ValueWidth
  ): CapturedValue | undefined;
  canInline(value: JitValue): boolean;
}>;

export function createValueCache(
  body: WasmFunctionBodyEncoder,
  cachePlan: CachePlan | undefined,
  capturePlan: CapturePlan | undefined,
  instructions: readonly InstructionEpochs[]
): ValueCache | undefined {
  if (cachePlan === undefined) {
    return undefined;
  }

  const plan = cachePlan;
  const store = new LocalStore(body);
  const captures = capturePlan;
  let currentEpoch = 0;
  let currentInstructionIndex = 0;
  let currentOpIndex = 0;
  let currentPath = rootPath();
  const pathStack: Path[] = [];

  return {
    beginInstruction: (index) => {
      if (index < 0 || index >= instructions.length) {
        throw new Error(`JIT value cache instruction index out of range: ${index}`);
      }

      currentInstructionIndex = index;
      currentOpIndex = 0;
      currentEpoch = currentInstructionPlan().opEpochs[0] ?? currentEpoch;
    },
    beginOp: (opIndex) => {
      const instructionPlan = currentInstructionPlan();

      if (opIndex < 0 || opIndex >= instructionPlan.opEpochs.length) {
        throw new Error(`JIT value cache expression op index out of range: ${opIndex}`);
      }

      currentOpIndex = opIndex;
      currentEpoch = instructionPlan.opEpochs[opIndex] ?? currentEpoch;
    },
    emitForUse: (value, emitter) => {
      if (valueIsConsumerAtCurrentEpoch(value)) {
        const available = store.get(value);

        if (available !== undefined) {
          return available;
        }

        return store.tee(value, emitter());
      }

      return store.get(value) ?? { valueWidth: emitter() };
    },
    capture: (value, emitter) => {
      const available = store.retainAvailable(value);

      if (available !== undefined) {
        return available;
      }

      if (!valueHasCaptureAtCurrentPlacement(value)) {
        return undefined;
      }

      return store.set(value, emitter());
    },
    canInline: (value) => !valueIsConsumerAtCurrentEpoch(value),
    enterPath: (path) => {
      pathStack.push(currentPath);
      currentPath = path;
      store.enterPath(path);
    },
    leavePath: () => {
      const previousPath = pathStack.pop();

      store.leavePath();

      if (previousPath !== undefined) {
        currentPath = previousPath;
      }
    }
  };

  function valueIsConsumerAtCurrentEpoch(value: JitValue): boolean {
    return valueIsSelected(currentEpochPlan()?.consumers ?? [], value);
  }

  function valueHasCaptureAtCurrentPlacement(value: JitValue): boolean {
    const placement = currentPlacement();
    const placementCaptures = captures?.byPlacement.get(placementKey(placement)) ?? [];

    return placementCaptures.some((capture) =>
      pathsEqual(capture.availability, currentPath) &&
        valuesEqual(simplifyValue(capture.value), simplifyValue(value))
    );
  }

  function currentEpochPlan() {
    return plan.epochs[currentEpoch];
  }

  function currentInstructionPlan() {
    const instructionPlan = instructions[currentInstructionIndex];

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

function placementKey(placement: Placement): string {
  return `${placement.instructionIndex}:${placement.opIndex}:${placement.epoch}`;
}
