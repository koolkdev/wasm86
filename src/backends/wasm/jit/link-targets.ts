import type { ValueRef } from "#x86/ir/model/types.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { JitBlock } from "./ir/types.js";

export function staticJitLinkTargets(block: JitBlock): readonly number[] {
  const instruction = block.instructions[block.instructions.length - 1];

  if (instruction === undefined || instruction.nextMode !== "exit") {
    return [];
  }

  return staticTerminatorTargets(instruction);
}

function staticTerminatorTargets(instruction: JitBlock["instructions"][number]): readonly number[] {
  const op = instruction.ir[instruction.ir.length - 1];

  switch (op?.op) {
    case "next":
      return [u32(instruction.nextEip)];
    case "jump":
      return optionalTarget(staticTargetForValue(instruction, op.target));
    case "conditionalJump":
      return uniqueTargets([
        staticTargetForValue(instruction, op.taken),
        staticTargetForValue(instruction, op.notTaken)
      ]);
    default:
      return [];
  }
}

function staticTargetForValue(
  instruction: JitBlock["instructions"][number],
  value: ValueRef
): number | undefined {
  switch (value.kind) {
    case "const":
      return u32(value.value);
    case "nextEip":
      return u32(instruction.nextEip);
    case "var":
      return staticTargetForVar(instruction, value);
  }
}

function staticTargetForVar(
  instruction: JitBlock["instructions"][number],
  value: Extract<ValueRef, { kind: "var" }>
): number | undefined {
  const producer = instruction.ir.find((op) =>
    (op.op === "get" || op.op === "value.const") && op.dst.id === value.id
  );

  if (producer?.op === "value.const") {
    return u32(producer.value);
  }

  if (producer?.op !== "get" || producer.source.kind !== "operand") {
    return undefined;
  }

  const binding = instruction.operands[producer.source.index];

  return binding?.kind === "static.relTarget" ? binding.target : undefined;
}

function optionalTarget(target: number | undefined): readonly number[] {
  return target === undefined ? [] : [target];
}

function uniqueTargets(targets: readonly (number | undefined)[]): readonly number[] {
  const unique: number[] = [];
  const seen = new Set<number>();

  for (const target of targets) {
    if (target === undefined || seen.has(target)) {
      continue;
    }

    unique.push(target);
    seen.add(target);
  }

  return unique;
}
