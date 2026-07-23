import type {
  InstructionBuilder,
  InstructionConstruction
} from "#core/instruction/builder.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import { buildFunction } from "#compiler/ir/builder/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import { testInstructionConstruction } from "#test/support/execution-model.js";

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
  construction: InstructionConstruction = testInstructionConstruction
): IrFunction {
  return buildFunction(instructionFunctionType, (fn) => {
    const finalFallthrough = construction.build(
      fn.region,
      instructionFunctionTerminals(),
      build
    );

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
