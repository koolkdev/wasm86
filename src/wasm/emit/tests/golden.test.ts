import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/operands.js";
import type { IrBlock } from "#ir/block.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { irBlockBody } from "./harness.js";

// Pinned harness-embedded bodies (fallthrough continue + sentinel tail):
// these bytes may only change when the emission itself deliberately does.

test("an alu pair emits its golden body", () => {
  // add eax, ebx; add eax, ebx.
  strictEqual(
    emitGolden([
      [0x01, 0xd8],
      [0x01, 0xd8]
    ]),
    "01027f41004100280200410028020c6a2200410028020c6a22012000493a002c4100200141ff017169410171453a002d41" +
      "002000410028020c732001734104764101713a002e41002001453a002f41002001411f763a003041002000200173410028020c" +
      "20017371411f763a0031410020013602004100410028022441026a3602244100418420360220427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01017f410028020c41046a210020003f0141107441046b4b044041004180203602202000ad4280808080b0808002840f0b20" +
      "00284201002100410020003602004100410028022441016a3602244100418320360220427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01077f41002802004105492100410028020041056b220141ff01716941017145210241002802004105732203200173410476" +
      "410171210420014521052001411f7621062003410028020020017371411f762101410028022441026a21032005044041002000" +
      "3a002c410020023a002d410020043a002e410020053a002f410020063a0030410020013a003141002003360224410041a520" +
      "36022005410020003a002c410020023a002d410020043a002e410020053a002f410020063a0030410020013a003141002003" +
      "36022441004185203602200b427f0b"
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
      case "imm":
        return immBinding(operand.value);
      case "relTarget":
        // The decoder already resolved the absolute target.
        return immBinding(operand.target);
      case "mem":
        return memBinding({
          ...(operand.base === undefined ? {} : { base: operand.base }),
          ...(operand.index === undefined ? {} : { index: operand.index }),
          scale: operand.scale,
          disp: operand.disp
        });
    }
  });
}
