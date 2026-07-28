import type { InstructionBuilder } from "#instructions/lowering/builder.js";
import type { InstructionLowerer } from "#instructions/lowering/lowerer.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/reference.js";
import { buildFunction } from "#compiler/ir/builder/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import { testInstructionLowerer } from "#test/support/execution-model.js";

const instructionFunctionType = functionType([], ["i64"]);
const dispatchFunctionType = functionType(["i32"], ["i64"]);
const noEffects = { reads: [], writes: [] } as const;

export const testInstructionDispatch = new FunctionDefinition({
  ref: functionRef("test.instruction.dispatch"),
  type: dispatchFunctionType,
  effects: noEffects,
  owner: undefined,
  build: (fn) => fn.return([fn.values.const64(0n)])
});

export function buildInstructionFunction(
  build: (instructions: InstructionBuilder) => void,
  lowerer: InstructionLowerer = testInstructionLowerer
): IrFunction {
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
