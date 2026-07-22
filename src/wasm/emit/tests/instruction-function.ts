import { assert } from "#common/assert.js";
import type {
  InstructionBuilder,
  InstructionLocation
} from "#core/instruction/builder.js";
import type { OperandBinding } from "#core/instruction/bindings.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import type { FunctionBuilder } from "#ir/function.js";
import { testInstructionConstruction } from "#test/support/execution-model.js";
import {
  returnTestFunctionCompleted,
  testFunction,
  type TestFunction
} from "./harness.js";

type InstructionEntry = Readonly<{
  template: SemanticTemplate;
  bindings: readonly OperandBinding[];
  location: InstructionLocation;
}>;

export type InstructionFunctionBuilder = Readonly<{
  add(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void;
  finish(): TestFunction;
}>;

export function createInstructionFunction(): InstructionFunctionBuilder {
  const entries: InstructionEntry[] = [];
  let finished = false;

  return {
    add(template, bindings, location) {
      assert(!finished, "cannot add to a finished test instruction function");
      entries.push({ template, bindings: [...bindings], location });
    },
    finish() {
      assert(!finished, "cannot finish a test instruction function twice");
      assert(entries.length > 0, "no instructions were added");
      finished = true;
      return testFunction(0, (fn) => buildInstructionEntries(fn, entries));
    }
  };
}

export function buildTestInstructions(
  fn: FunctionBuilder,
  build: (instructions: InstructionBuilder) => void
): void {
  const instructions = testInstructionConstruction.createBuilder(
    fn.region,
    {
      dispatch: (body) => body.return([body.values.const64(-1n)]),
      returnExit: (body, result) => body.return([result])
    }
  );

  build(instructions);
  const finalFallthrough = instructions.finish();

  if (finalFallthrough !== undefined) {
    returnTestFunctionCompleted(fn);
  }
}

function buildInstructionEntries(
  fn: FunctionBuilder,
  entries: readonly InstructionEntry[]
): void {
  buildTestInstructions(fn, (instructions) => {
    for (const entry of entries) {
      if (!instructions.add(entry.template, entry.bindings, entry.location)) {
        break;
      }
    }
  });
}
