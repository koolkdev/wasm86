import type {
  InstructionConstruction,
  InstructionLocation
} from "#core/instruction/builder.js";
import type { OperandBinding } from "#core/instruction/bindings.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import { testInstructionConstruction } from "./execution-model.js";

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

type InstructionFunctionBuilder = Readonly<{
  add(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): boolean;
  finish(): IrFunction;
}>;

export function createInstructionFunction(
  construction: InstructionConstruction = testInstructionConstruction
): InstructionFunctionBuilder {
  const fn = new FunctionBuilder(instructionFunctionType);
  const instructions = construction.createBuilder(
    fn.region,
    instructionFunctionTerminals()
  );

  return {
    add: (template, bindings, location) =>
      instructions.add(template, bindings, location),
    finish: () => {
      const finalFallthrough = instructions.finish();

      if (finalFallthrough !== undefined) {
        fn.returnCall(testInstructionDispatch, [finalFallthrough]);
      }
      return fn.finish();
    }
  };
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
