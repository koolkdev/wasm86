import { assert } from "#common/assert.js";
import { maxSwitchMatch } from "#compiler/ir/controls/index.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type {
  DecodeCandidate,
  DecodeOperand,
  InstructionForm
} from "#core/decoder/model/types.js";

export type ModRmCandidateCase = Readonly<{
  form: InstructionForm;
  registerMatches: readonly number[];
  memoryMatches: readonly number[];
}>;

type MemoryFormLocation = Readonly<{
  page: number;
  index: number;
}>;

const formIds = new Set<string>();

for (const form of X86_32_DECODE_MODEL.forms) {
  assert(!formIds.has(form.id), `duplicate decode form id ${form.id}`);
  formIds.add(form.id);
}

const memoryForms = X86_32_DECODE_MODEL.forms.filter((form) => {
  if (form.modrm === undefined) {
    return false;
  }
  assert(
    modRmOperand(form) !== undefined,
    `${form.id} uses ModRM without an R/M operand`
  );
  return form.modrm.acceptedBytes.some(
    (accepted, byte) => accepted && (byte >>> 6) !== 0b11
  );
});
const memoryFormPageSize = maxSwitchMatch + 1;
const memoryFormLocations = new Map<string, MemoryFormLocation>();

memoryForms.forEach((form, ordinal) => {
  memoryFormLocations.set(form.id, {
    page: Math.floor(ordinal / memoryFormPageSize),
    index: ordinal % memoryFormPageSize
  });
});

export const memoryFormDispatch = {
  pages: Array.from(
    { length: Math.ceil(memoryForms.length / memoryFormPageSize) },
    (_, page) => memoryForms.slice(
      page * memoryFormPageSize,
      (page + 1) * memoryFormPageSize
    )
  ),
  locations: memoryFormLocations as ReadonlyMap<string, MemoryFormLocation>
} as const;

export function modRmCandidateCases(
  candidate: Extract<DecodeCandidate, { kind: "modRm" }>
): readonly ModRmCandidateCase[] {
  const byForm = new Map<string, {
    form: InstructionForm;
    registerMatches: number[];
    memoryMatches: number[];
  }>();

  candidate.byByte.forEach((form, byte) => {
    if (form === undefined) {
      return;
    }
    const existing = byForm.get(form.id) ?? {
      form,
      registerMatches: [],
      memoryMatches: []
    };
    const matches = modRmPath(form, byte) === "register"
      ? existing.registerMatches
      : existing.memoryMatches;

    matches.push(byte);
    byForm.set(form.id, existing);
  });
  return [...byForm.values()];
}

function modRmOperand(
  form: InstructionForm
): Extract<DecodeOperand, { kind: "modrm.rm" }> | undefined {
  return form.operands.find(
    (operand): operand is Extract<DecodeOperand, { kind: "modrm.rm" }> =>
      operand.kind === "modrm.rm"
  );
}

function modRmPath(
  form: InstructionForm,
  byte: number
): "register" | "memory" {
  const rmOperand = modRmOperand(form);

  assert(rmOperand !== undefined, `${form.id} uses ModRM without an R/M operand`);
  if ((byte >>> 6) !== 0b11) {
    return "memory";
  }
  assert(
    rmOperand.form === "registerOrMemory",
    `${form.id} accepts a register ModRM byte for a memory-only operand`
  );
  return "register";
}
