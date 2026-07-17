import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, regBinding, staticMemSegment, type OperandBinding } from "#ir/operands.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#core/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#core/decoder/types.js";
import { defaultSegmentForBase } from "#core/segments.js";
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
    "01027f024041004100280218410028022422006a220120006a36021841002001360204410020003602084100410028029001" +
      "41026a360290014100410a3a000041004184203602380c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01017f0240410028022441046a220041fcff034b044041004180203602382000ad42808080808080c001840f0b" +
      "4100200028420100360218410041002802900141016a3602900141004183203602380c000b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01027f02404100280218220041054641002802900141026a210104404100200036020441004105360208410041093a00004100" +
      "200136029001410041a5203602380c010b4100200036020441004105360208410041093a00004100200136029001" +
      "41004185203602380c000b427f0b"
  );
});

function emitGolden(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(irBlockBody(blockOf(byteLists)).bytes).toString("hex");
}

function blockOf(
  byteLists: readonly (readonly number[])[],
  registerAlias: "base" | "name" = "base"
): IrBlock {
  const builder = createIrBlockBuilder();
  let address: number | undefined;

  for (const bytes of byteLists) {
    const instruction = address === undefined ? ok(decodeBytes(bytes)) : ok(decodeBytes(bytes, address));

    builder.addInstruction(
      instruction.spec.semantics,
      bindingsFor(instruction, registerAlias),
      loc(instruction.address, instruction.nextEip)
    );
    address = instruction.nextEip;
  }

  return builder.finish();
}

function bindingsFor(
  instruction: IsaDecodedInstruction,
  registerAlias: "base" | "name"
): readonly OperandBinding[] {
  return instruction.operands.map((operand) => {
    switch (operand.kind) {
      case "reg":
        return regBinding(registerAlias === "base" ? operand.alias.base : operand.alias.name);
      case "segment":
        throw new Error("segment operands not supported in golden tests");
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        // The decoder already resolved the absolute target.
        return immBinding(operand.target);
      case "mem":
        return memBinding({
          base: operand.base,
          index: operand.index,
          scale: operand.scale,
          disp: operand.disp
        }, staticMemSegment(operand.segment ?? defaultSegmentForBase(operand.base)));
    }
  });
}
