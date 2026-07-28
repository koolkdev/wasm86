import { maxSwitchMatch } from "#compiler/ir/controls/index.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { InstructionForm, ModRmModeForms } from "#instructions/decoder/model/types.js";

type ModRmRegCase = Readonly<{
  matches: readonly number[];
  forms: ModRmModeForms;
}>;

type ExactModRmCase = Readonly<{
  matches: readonly number[];
  form: InstructionForm;
  mode: "register" | "memory";
}>;

const memoryForms = X86_32_DECODE_MODEL.forms.filter((form) => {
  if (form.modrm === undefined) {
    return false;
  }
  return form.modrm.acceptedBytes.some((accepted, byte) => accepted && byte >>> 6 !== 0b11);
});
const memoryFormGroupSize = maxSwitchMatch + 1;
const memoryFormOrdinals = new Map<InstructionForm, number>();

memoryForms.forEach((form, ordinal) => {
  memoryFormOrdinals.set(form, ordinal);
});

export const memoryFormDispatch = {
  groups: Array.from({ length: Math.ceil(memoryForms.length / memoryFormGroupSize) }, (_, group) =>
    memoryForms.slice(group * memoryFormGroupSize, (group + 1) * memoryFormGroupSize)
  ),
  ordinalByForm: memoryFormOrdinals as ReadonlyMap<InstructionForm, number>,
  groupSize: memoryFormGroupSize
} as const;

export function modRmRegCases(byReg: readonly ModRmModeForms[]): readonly ModRmRegCase[] {
  const cases: { matches: number[]; forms: ModRmModeForms }[] = [];

  byReg.forEach((forms, match) => {
    if (forms.register === undefined && forms.memory === undefined) {
      return;
    }
    const existing = cases.find(
      (candidate) =>
        candidate.forms.register === forms.register && candidate.forms.memory === forms.memory
    );

    if (existing === undefined) {
      cases.push({ matches: [match], forms });
    } else {
      existing.matches.push(match);
    }
  });
  return cases;
}

export function exactModRmCases(
  byByte: readonly (InstructionForm | undefined)[]
): readonly ExactModRmCase[] {
  const byForm = new Map<
    InstructionForm,
    {
      register: number[];
      memory: number[];
    }
  >();

  byByte.forEach((form, byte) => {
    if (form === undefined) {
      return;
    }
    const existing = byForm.get(form) ?? { register: [], memory: [] };
    const mode = byte >= 0xc0 ? "register" : "memory";

    existing[mode].push(byte);
    byForm.set(form, existing);
  });
  const cases: ExactModRmCase[] = [];

  for (const [form, matches] of byForm) {
    if (matches.register.length !== 0) {
      cases.push({ matches: matches.register, form, mode: "register" });
    }
    if (matches.memory.length !== 0) {
      cases.push({ matches: matches.memory, form, mode: "memory" });
    }
  }
  return cases;
}
