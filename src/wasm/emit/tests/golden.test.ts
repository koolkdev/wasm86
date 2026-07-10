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
    "01027f024041004100280200410028020c22006a220120006a3602004100200136022c4100200036023041004100280224" +
      "41026a3602244100410a3a002841004184203602200c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01017f0240410028020c41046a22003f0141107441046b4b044041004180203602202000ad4280808080e0e100840f0b" +
      "41002000284201003602004100410028022441016a36022441004183203602200c000b427f0b"
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
      "2001360224410041a5203602200c010b4100200036022c41004105360230410041093a002841002001360224" +
      "41004185203602200c000b427f0b"
  );
});

test("a live-in branch condition emits its lazy switch golden body", () => {
  // je +0x20.
  strictEqual(
    emitGoldenWithHelpers([[0x74, 0x20]]),
    "01017f02400240024002400240024002400240024041002d00280e0c060006010602060306040605060b41002d002c" +
      "41002d00304621000c060b41002d002c4521000c050b41002f012c41002f01304621000c040b41002f012c4521000c" +
      "030b410028022c41002802304621000c020b410028022c4521000c010b100021000b200004404100410028022441016a" +
      "360224410041a2203602200c010b4100410028022441016a36022441004182203602200c000b427f0b"
  );
});

test("a live-in setcc condition emits its lazy switch golden body", () => {
  // sete al.
  strictEqual(
    emitGoldenWithHelpers([[0x0f, 0x94, 0xc0]]),
    "01017f02400240024002400240024002400240024041002d00280e0c060006010602060306040605060b41002d002c" +
      "41002d00304621000c060b41002d002c4521000c050b41002f012c41002f01304621000c040b41002f012c4521000c" +
      "030b410028022c41002802304621000c020b410028022c4521000c010b100021000b41004101410020001b3a00004100" +
      "410028022441016a36022441004183203602200c000b427f0b"
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
