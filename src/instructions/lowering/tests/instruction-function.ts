import type { InstructionSequenceBuilder } from "#instructions/lowering/builder.js";
import type { InstructionLowerer } from "#instructions/lowering/lowerer.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import { functionType } from "#compiler/function/type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/reference.js";
import { buildFunction } from "#compiler/function/builder/function.js";
import type { FunctionBody } from "#compiler/function/body.js";
import { Integer, i64 } from "#compiler/function/values.js";
import { testInstructionLowerer } from "#test/support/execution-model.js";

const instructionFunctionType = functionType([], [Integer[64]]);
const dispatchFunctionType = functionType([Integer[32]], [Integer[64]]);
const noEffects = { reads: [], writes: [] } as const;

export const testInstructionDispatch = new FunctionDefinition({
  ref: functionRef("test.instruction.dispatch"),
  type: dispatchFunctionType,
  effects: noEffects,
  owner: undefined,
  buildStability: "dynamic",
  build: (fn) => fn.return([i64(0n)])
});

export function buildInstructionFunction(
  build: (instructions: InstructionSequenceBuilder) => void,
  lowerer: InstructionLowerer = testInstructionLowerer
): FunctionBody {
  return buildFunction(instructionFunctionType, (fn) => {
    const finalFallthrough = lowerer.lower(fn.region, instructionFunctionTerminals(), build);

    if (finalFallthrough !== undefined) {
      fn.returnCall(testInstructionDispatch, [finalFallthrough]);
    }
  });
}

function instructionFunctionTerminals(): InstructionTerminals {
  return {
    dispatch: (region, targetEip) => {
      region.returnCall(testInstructionDispatch, [targetEip]);
    },
    returnExit: (region, result) => {
      region.return([result]);
    }
  };
}
