import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, noMemSegment, regBinding, staticMemSegment, type OperandBinding } from "#ir/operands.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { irBlockBody, irBlockBodyWithHelpers } from "./harness.js";

// Pinned harness-embedded bodies (dispatch escape block + sentinel tail):
// these bytes may only change when the emission itself deliberately does.

test("an alu pair emits its golden body", () => {
  // add eax, ebx; add eax, ebx.
  strictEqual(
    emitGolden([
      [0x01, 0xd8],
      [0x01, 0xd8]
    ]),
    "01027f024041004100280200410028020c22006a220120006a36020041004184203602204100200136022c410020003602304100" +
      "410028022441026a3602244100410a3a00280c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01017f0240410028020c41046a22003f0141107441046b4b044041004180203602202000ad4280808080e0e100840f0b" +
      "410020002842010036020041004183203602204100410028022441016a3602240c000b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01027f024041002802002200410546410028022441026a210104404100200036022c41004105360230410041093a00284100" +
      "2001360224410041a5203602200c010b41004185203602204100200036022c41004105360230410041093a00284100" +
      "20013602240c000b427f0b"
  );
});

test("a live-in branch condition emits its lazy switch golden body", () => {
  // je +0x20.
  strictEqual(
    emitGoldenWithHelpers([[0x74, 0x20]]),
    "01017f02400240024002400240024002400240024041002d00280e0c060006010602060306040605060b41002d002c41002d0030" +
      "4621000c060b41002d002c4521000c050b41002f012c41002f01304621000c040b41002f012c4521000c030b" +
      "410028022c41002802304621000c020b410028022c4521000c010b100021000b2000410028022441016a2100044041002000360224" +
      "410041a2203602200c010b4100418220360220410020003602240c000b427f0b"
  );
});

test("a live-in setcc condition emits its lazy switch golden body", () => {
  // sete al.
  strictEqual(
    emitGoldenWithHelpers([[0x0f, 0x94, 0xc0]]),
    "01017f02400240024002400240024002400240024041002d00280e0c060006010602060306040605060b41002d002c41002d0030" +
      "4621000c060b41002d002c4521000c050b41002f012c41002f01304621000c040b41002f012c4521000c030b" +
      "410028022c41002802304621000c020b410028022c4521000c010b100021000b41004101410020001b3a0000" +
      "41004183203602204100410028022441016a3602240c000b427f0b"
  );
});

function emitGolden(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(irBlockBody(blockOf(byteLists)).encode()).toString("hex");
}

function emitGoldenWithHelpers(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(irBlockBodyWithHelpers(blockOf(byteLists, "name")).encode()).toString("hex");
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
        }, operand.segment === undefined ? noMemSegment() : staticMemSegment(operand.segment));
    }
  });
}
