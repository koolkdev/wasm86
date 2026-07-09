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
    "01047f024041002802002100410028020c2101410028022421024100200020016a220320016a3602004100200336022c" +
      "410020013602304100200241026a3602244100410a3a002841004184203602200c000b427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01047f0240410028020c2100200041046a22013f0141107441046b4b21022002044041004180203602202001ad" +
      "4280808080e0e100840f0b200128420100210141002802242103410020013602004100200341016a360224" +
      "41004183203602200c000b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01037f024041002802002100410028022421012000410546200141026a210204404100200036022c410041053602304100" +
      "41093a002841002002360224410041a5203602200c010b4100200036022c41004105360230410041093a002841002002360224" +
      "41004185203602200c000b427f0b"
  );
});

test("a live-in branch condition emits its lazy switch golden body", () => {
  // je +0x20.
  strictEqual(
    emitGoldenWithHelpers([[0x74, 0x20]]),
    "010e7f024041002d002821000240024002400240024002400240024020000e0c060006010602060306040605060b" +
      "41002d002c210241002d00302103200220034621010c060b41002d002c210420044521010c050b41002f012c2105" +
      "41002f01302106200520064621010c040b41002f012c210720074521010c030b410028022c210841002802302109" +
      "200820094621010c020b410028022c210a200a4521010c010b1000210b200b21010b200104404100280224210c" +
      "4100200c41016a360224410041a2203602200c010b4100280224210d4100200d41016a3602244100418220360220" +
      "0c000b427f0b"
  );
});

test("a live-in setcc condition emits its lazy switch golden body", () => {
  // sete al.
  strictEqual(
    emitGoldenWithHelpers([[0x0f, 0x94, 0xc0]]),
    "010d7f024041002d002821000240024002400240024002400240024020000e0c060006010602060306040605060b" +
      "41002d002c210241002d00302103200220034621010c060b41002d002c210420044521010c050b41002f012c2105" +
      "41002f01302106200520064621010c040b41002f012c210720074521010c030b410028022c210841002802302109" +
      "200820094621010c020b410028022c210a200a4521010c010b1000210b200b21010b4100280224210c41004101" +
      "410020011b3a00004100200c41016a36022441004183203602200c000b427f0b"
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
