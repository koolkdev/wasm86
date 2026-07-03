import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { irBlockBody } from "./harness.js";

// Pinned harness-embedded bodies (dispatch escape block + sentinel tail):
// these bytes may only change when the emission itself deliberately does.

test("an alu pair emits its golden body", () => {
  // add eax, ebx; add eax, ebx.
  strictEqual(
    emitGolden([
      [0x01, 0xd8],
      [0x01, 0xd8]
    ]),
    "01017f024041004100280200410028020c6a2200410028020c6a36020041004184203602204100200036022c4100410028020c" +
      "3602304100410028022441026a36022441004182013a00280c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01027f0240410028020c41046a22003f0141107441046b4b21012001044041004180203602202000ad4280808080e0e100840f0b" +
      "20002842010021004100200036020041004183203602204100410028022441016a3602240c000b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01017f0240410028022441026a210041002802004105460440410041a5203602204100410028020036022c410041053602304100" +
      "4181013a0028410020003602240c010541004185203602204100410028020036022c4100410536023041004181013a00284100" +
      "20003602240c010b0b427f0b"
  );
});

function emitGolden(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(irBlockBody(blockOf(byteLists)).encode()).toString("hex");
}

function blockOf(byteLists: readonly (readonly number[])[]): IrBlock {
  const builder = createIrBlockBuilder();
  let address: number | undefined;

  for (const bytes of byteLists) {
    const instruction = address === undefined ? ok(decodeBytes(bytes)) : ok(decodeBytes(bytes, address));

    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), loc(instruction.address, instruction.nextEip));
    address = instruction.nextEip;
  }

  return builder.finish();
}

function bindingsFor(instruction: IsaDecodedInstruction): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        return regBinding(operand.alias.base);
      case "segment":
        throw new Error("segment operands not supported in golden tests");
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        // The decoder already resolved the absolute target.
        return immBinding(operand.target);
      case "mem":
        return memBinding({
          segment: operand.segment,
          base: operand.base,
          index: operand.index,
          scale: operand.scale,
          disp: operand.disp
        });
    }
  });
}
