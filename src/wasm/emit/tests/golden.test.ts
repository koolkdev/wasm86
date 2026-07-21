import { strictEqual } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import { immBinding, memBinding, regBinding, staticMemSegment, type OperandBinding } from "#core/instruction/bindings.js";
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
    "01027f024041004100280218410028022422006a220120006a36021841004184203602384100200136020441002000360208" +
      "410041002802900141026a360290014100410a3a00000c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01017f0240410028022441046a220041fcff034b044041004180203602382000ad428080808080808002840f0b" +
      "41002000284201003602184100418320360238410041002802900141016a360290010c000b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01027f02404100280218220041054641002802900121010440410041a5203602384100200036020441004105360208" +
      "410041093a00004100200141026a360290010c010b41004185203602384100200036020441004105360208410041093a" +
      "00004100200141026a360290010c000b427f0b"
  );
});

function emitGolden(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(irBlockBody(blockOf(byteLists)).bytes).toString("hex");
}

function blockOf(
  byteLists: readonly (readonly number[])[],
  registerAlias: "base" | "name" = "base"
): IrBlock {
  const builder = createLegacyInstructionBlock();
  let address: number | undefined;

  for (const bytes of byteLists) {
    const instruction = address === undefined ? ok(decodeBytes(bytes)) : ok(decodeBytes(bytes, address));

    builder.add(
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
