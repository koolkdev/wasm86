import { strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { decodeBytes, ok as decoded } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import {
  staticInstructionLocation as loc
} from "#core/instruction/builder.js";
import { staticOperandBinding } from "#core/instruction/static-binding.js";
import { createInstructionFunction } from "./instruction-function.js";
import { testFunctionBody } from "./harness.js";

test("DIV r/m32 lowering uses unsigned i64 quotient and remainder operations", () => {
  const opcodes = opcodesOf(decoded(decodeBytes([0xf7, 0xf3])));

  strictEqual(opcodes.includes(wasmOpcode.i64DivU), true);
  strictEqual(opcodes.includes(wasmOpcode.i64RemU), true);
});

test("IDIV r/m32 lowering uses signed i64 operations and quotient guards", () => {
  const opcodes = opcodesOf(decoded(decodeBytes([0xf7, 0xfb])));

  strictEqual(opcodes.includes(wasmOpcode.i64DivS), true);
  strictEqual(opcodes.includes(wasmOpcode.i64RemS), true);
  strictEqual(opcodes.includes(wasmOpcode.i64Eq), true);
  strictEqual(opcodes.includes(wasmOpcode.i64Ne), true);
});

function opcodesOf(instruction: IsaDecodedInstruction): readonly number[] {
  const builder = createInstructionFunction();

  builder.add(
    instruction.spec.semantics,
    instruction.operands.map(staticOperandBinding),
    loc(instruction.address, instruction.nextEip)
  );

  return wasmBodyOpcodes(testFunctionBody(builder.finish()));
}
