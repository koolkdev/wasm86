import type { ValueRef } from "#x86/ir/model/types.js";
import { visitIrOpValueRefs } from "#x86/ir/model/op-semantics.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { walkJitIrBlockOps } from "#backends/wasm/jit/ir/walk.js";
import { jitExitConditionValues, jitLocalConditionValues } from "#backends/wasm/jit/ir/effect-primitives.js";

export type JitConditionUse = "localCondition" | "exitCondition";

type JitOpIndex<T> = ReadonlyMap<number, ReadonlyMap<number, T>>;

export type JitConditionUseIndex = JitOpIndex<JitConditionUse>;
export type JitLocalConditionValueIndex = JitOpIndex<readonly ValueRef[]>;
export type JitExitConditionValueIndex = JitOpIndex<readonly ValueRef[]>;

export function indexJitLocalConditionValues(block: JitIrBlock): JitLocalConditionValueIndex {
  const byLocation = new Map<number, Map<number, readonly ValueRef[]>>();

  walkJitIrBlockOps(block, (_instruction, op, location) => {
    const values = jitLocalConditionValues(op);

    if (values.length !== 0) {
      setJitOpIndexValue(byLocation, location.instructionIndex, location.opIndex, values);
    }
  }, "indexing local condition values");

  return byLocation;
}

export function indexJitExitConditionValues(block: JitIrBlock): JitExitConditionValueIndex {
  const byLocation = new Map<number, Map<number, readonly ValueRef[]>>();

  walkJitIrBlockOps(block, (instruction, op, location) => {
    const values = jitExitConditionValues(op, instruction);

    if (values.length !== 0) {
      setJitOpIndexValue(byLocation, location.instructionIndex, location.opIndex, values);
    }
  }, "indexing exit condition values");

  return byLocation;
}

export function analyzeJitConditionUses(
  block: JitIrBlock,
  localConditionValues: JitLocalConditionValueIndex = indexJitLocalConditionValues(block),
  exitConditionValues: JitExitConditionValueIndex = indexJitExitConditionValues(block)
): JitConditionUseIndex {
  const byLocation = new Map<number, Map<number, JitConditionUse>>();

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while analyzing condition uses: ${instructionIndex}`);
    }

    const exitConditionVars = new Set<number>();
    const localConditionVars = new Set<number>();
    const conditionVars = instructionConditionVars(instruction);

    for (const values of localConditionValues.get(instructionIndex)?.values() ?? []) {
      addConditionVars(localConditionVars, values);
    }

    for (const values of exitConditionValues.get(instructionIndex)?.values() ?? []) {
      addConditionVars(exitConditionVars, values);
    }

    validateConditionConsumers(
      instruction,
      instructionIndex,
      conditionVars,
      localConditionValues.get(instructionIndex),
      exitConditionValues.get(instructionIndex)
    );

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while analyzing condition uses: ${instructionIndex}:${opIndex}`);
      }

      if (op.op !== "flags.condition") {
        continue;
      }

      const conditionUse = conditionUseForVar(op.dst.id, localConditionVars, exitConditionVars);

      if (conditionUse === undefined) {
        continue;
      }

      setJitOpIndexValue(byLocation, instructionIndex, opIndex, conditionUse);
    }
  }

  return byLocation;
}

function instructionConditionVars(instruction: JitIrBlockInstruction): ReadonlySet<number> {
  const conditionVars = new Set<number>();

  for (const op of instruction.ir) {
    if (op.op === "flags.condition") {
      conditionVars.add(op.dst.id);
    }
  }

  return conditionVars;
}

function validateConditionConsumers(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  conditionVars: ReadonlySet<number>,
  localConditionValues: ReadonlyMap<number, readonly ValueRef[]> | undefined,
  exitConditionValues: ReadonlyMap<number, readonly ValueRef[]> | undefined
): void {
  if (conditionVars.size === 0) {
    return;
  }

  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while validating condition consumers: ${instructionIndex}:${opIndex}`);
    }

    const declaredConditionVars = declaredConditionVarsAt(
      localConditionValues?.get(opIndex),
      exitConditionValues?.get(opIndex)
    );

    visitIrOpValueRefs(op, (value, role) => {
      if (value.kind !== "var" || !conditionVars.has(value.id)) {
        return;
      }

      if (role === "condition") {
        if (!declaredConditionVars.has(value.id)) {
          throw new Error(
            `JIT condition value ${value.id} is consumed without a declared condition consumer at ${instructionIndex}:${opIndex}`
          );
        }

        return;
      }

      throw new Error(
        `JIT condition value ${value.id} is used as an ordinary value at ${instructionIndex}:${opIndex}`
      );
    });
  }
}

function declaredConditionVarsAt(
  localConditionValues: readonly ValueRef[] | undefined,
  exitConditionValues: readonly ValueRef[] | undefined
): ReadonlySet<number> {
  const vars = new Set<number>();

  if (localConditionValues !== undefined) {
    addConditionVars(vars, localConditionValues);
  }

  if (exitConditionValues !== undefined) {
    addConditionVars(vars, exitConditionValues);
  }

  return vars;
}

function conditionUseForVar(
  varId: number,
  localConditionVars: ReadonlySet<number>,
  exitConditionVars: ReadonlySet<number>
): JitConditionUse | undefined {
  if (exitConditionVars.has(varId)) {
    return "exitCondition";
  }

  if (localConditionVars.has(varId)) {
    return "localCondition";
  }

  return undefined;
}

function addConditionVars(vars: Set<number>, values: readonly ValueRef[]): void {
  for (const value of values) {
    if (value.kind === "var") {
      vars.add(value.id);
    }
  }
}

function setJitOpIndexValue<T>(
  index: Map<number, Map<number, T>>,
  instructionIndex: number,
  opIndex: number,
  value: T
): void {
  let instructionValues = index.get(instructionIndex);

  if (instructionValues === undefined) {
    instructionValues = new Map();
    index.set(instructionIndex, instructionValues);
  }

  instructionValues.set(opIndex, value);
}
