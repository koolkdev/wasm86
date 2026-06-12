import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, memBinding, regBinding, type OperandBinding } from "#ir/action/operands.js";
import type { ActionBlock } from "#ir/action/types.js";
import { decodeBytes, ok } from "#x86/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import { actionBlockBody } from "./harness.js";

// Pinned harness-embedded bodies (fallthrough continue + sentinel tail):
// these bytes may only change when the emission itself deliberately does.

test("an alu pair emits its golden body", () => {
  // add eax, ebx; add eax, ebx.
  strictEqual(
    emitGolden([
      [0x01, 0xd8],
      [0x01, 0xd8]
    ]),
    "01027f41004100280200410028020c6a2200410028020c6a2201453a003741002001411f763a00384100200141ff01716941" +
      "0171453a0035410020012000493a003441002000410028020c732001734104764101713a003641002000200173410028020c" +
      "20017371411f763a0039410020013602004100410028022c41026a36022c4100418420360220427f0b"
  );
});

test("a guarded load emits its golden body", () => {
  // mov eax, [ebx+4].
  strictEqual(
    emitGolden([[0x8b, 0x43, 0x04]]),
    "01027f02400240410028020c41046a210020003f0141107441046b4b0d002000284201002101410020013602004100410028" +
      "022c41016a36022c41004183203602200c010b41004180203602202000ad4280808080d0808002840f0b427f0b"
  );
});

test("a compare and branch emits its golden body", () => {
  // cmp eax, 5; je +0x20.
  strictEqual(
    emitGolden([
      [0x83, 0xf8, 0x05],
      [0x74, 0x20]
    ]),
    "01077f024002400240410028020041056b22004521012000411f762102200041ff0171694101714521034100280200410549" +
      "21044100280200410573220520007341047641017121062005410028020020007371411f762100410028022c41026a210541" +
      "002802004105460d010b410020013a0037410020023a0038410020033a0035410020043a0034410020063a0036410020003a" +
      "00394100200536022c41004185203602200c010b410020013a0037410020023a0038410020033a0035410020043a00344100" +
      "20063a0036410020003a00394100200536022c410041a5203602200b427f0b"
  );
});

function emitGolden(byteLists: readonly (readonly number[])[]): string {
  return Buffer.from(actionBlockBody(blockOf(byteLists)).encode()).toString("hex");
}

function blockOf(byteLists: readonly (readonly number[])[]): ActionBlock {
  const builder = createActionBuilder();
  let address: number | undefined;

  for (const bytes of byteLists) {
    const instruction = address === undefined ? ok(decodeBytes(bytes)) : ok(decodeBytes(bytes, address));

    builder.addInstruction(instruction.spec.semantics, bindingsFor(instruction), {
      eip: instruction.address,
      nextEip: instruction.nextEip
    });
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
