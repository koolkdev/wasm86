import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";

test("the decoder model covers the architectural ModRM and SIB encodings", () => {
  const { addressForms } = X86_32_DECODE_MODEL;
  const sibBases = [
    "eax",
    "ecx",
    "edx",
    "ebx",
    "esp",
    "ebp",
    "esi",
    "edi"
  ] as const;

  deepStrictEqual(addressForms.sibIndexes, [
    "eax",
    "ecx",
    "edx",
    "ebx",
    undefined,
    "ebp",
    "esi",
    "edi"
  ]);
  deepStrictEqual(addressForms.sibScales, [1, 2, 4, 8]);
  strictEqual(addressForms.modes.length, 4);
  strictEqual(addressForms.modes[3]?.kind, "register");

  for (const mode of addressForms.modes.slice(0, 3)) {
    strictEqual(mode.kind, "memory");
    if (mode.kind !== "memory") {
      continue;
    }

    strictEqual(mode.rm.length, 8);
    const sib = mode.rm[4];

    strictEqual(sib?.kind, "sib");
    if (sib?.kind !== "sib") {
      continue;
    }

    strictEqual(sib.bases.length, 8);
    ok(
      sib.bases.every(
        (address, encoding) =>
          address.base === undefined || address.base === sibBases[encoding]
      )
    );
    ok(
      sib.bases.filter((address) => address.base === undefined).length <= 1
    );
    const dynamicBases = sib.bases.filter(
      (address) => address.base !== undefined
    );
    const displacement = dynamicBases[0]?.displacement;

    ok(displacement !== undefined);
    ok(
      dynamicBases.every(
        (address) =>
          address.displacement.byteLength === displacement.byteLength &&
          address.displacement.signed === displacement.signed
      )
    );
    deepStrictEqual(
      [...new Set(dynamicBases.map((address) => address.defaultSegment))].sort(),
      ["ds", "ss"]
    );
  }
});

test("every memory-capable ModRM form owns an R/M operand", () => {
  for (const form of X86_32_DECODE_MODEL.forms) {
    const acceptsMemory = form.modrm?.acceptedBytes.some(
      (accepted, byte) => accepted && (byte >>> 6) !== 0b11
    ) ?? false;

    if (acceptsMemory) {
      ok(
        form.operands.some((operand) => operand.kind === "modrm.rm"),
        form.id
      );
    }
  }
});
