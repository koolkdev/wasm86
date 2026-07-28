import { assert } from "#common/assert.js";
import type { InstructionForm, ModRmFormSelection, ModRmModeForms } from "./types.js";

const nonUniform = Symbol("nonUniformModRmForms");

export function deriveModRmFormSelection(
  byByte: readonly (InstructionForm | undefined)[]
): ModRmFormSelection {
  const byReg: ModRmModeForms[] = [];

  for (let reg = 0; reg < 8; reg += 1) {
    const register = uniformForm(byByte, reg, [0b11]);
    const memory = uniformForm(byByte, reg, [0b00, 0b01, 0b10]);

    if (register === nonUniform || memory === nonUniform) {
      return { kind: "exact", byByte };
    }
    byReg.push({ register, memory });
  }

  assert(
    byReg.some(({ register, memory }) => register !== undefined || memory !== undefined),
    "ModRM candidate accepts no bytes"
  );
  const first = byReg[0]!;

  return {
    kind: "fields",
    fields: byReg.every((forms) => sameForms(forms, first))
      ? { kind: "mode", forms: first }
      : { kind: "reg", byReg }
  };
}

export function selectModRmForm(
  selection: ModRmFormSelection,
  byte: number
): InstructionForm | undefined {
  const mode = byte >= 0xc0 ? "register" : "memory";

  switch (selection.kind) {
    case "exact":
      return selection.byByte[byte];
    case "fields":
      switch (selection.fields.kind) {
        case "mode":
          return selection.fields.forms[mode];
        case "reg":
          return selection.fields.byReg[(byte >>> 3) & 0b111]?.[mode];
      }
  }
}

function uniformForm(
  byByte: readonly (InstructionForm | undefined)[],
  reg: number,
  modes: readonly number[]
): InstructionForm | undefined | typeof nonUniform {
  let selected = byByte[(modes[0]! << 6) | (reg << 3)];

  for (const mode of modes) {
    for (let rm = 0; rm < 8; rm += 1) {
      const form = byByte[(mode << 6) | (reg << 3) | rm];

      if (form !== selected) {
        return nonUniform;
      }
    }
  }
  return selected;
}

function sameForms(left: ModRmModeForms, right: ModRmModeForms): boolean {
  return left.register === right.register && left.memory === right.memory;
}
