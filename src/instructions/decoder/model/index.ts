import { assert } from "#common/assert.js";
import { X86_32_CORE } from "#instructions/isa/x86-32.js";
import type { InstructionSpec } from "#instructions/isa/spec.js";
import {
  operandSizeOverridePrefixByte,
  repnePrefixByte,
  repPrefixByte,
  segmentOverridePrefixSegments
} from "#instructions/prefixes.js";
import { deriveModRmFormSelection } from "./candidates.js";
import type {
  DecodeCandidate,
  InstructionForm,
  OpcodeLeaf,
  OpcodeNode,
  PrefixEffect,
  PrefixModel,
  X86DecodeModel
} from "./types.js";
import { buildInstructionForms } from "./forms.js";
import { buildModRm32 } from "./modrm32.js";

type MutableDecodeOpcodeNode = {
  leaf: OpcodeLeaf | undefined;
  next: (MutableDecodeOpcodeNode | undefined)[];
};

type MutableDecodeOpcodeLeaf = {
  opcodeLength: number;
  formsByPrefix: InstructionForm[][];
};

const prefixFlagBits = {
  operandSizeOverride: 1 << 0,
  rep: 1 << 1,
  repne: 1 << 2
} as const;
const prefixFlagMask =
  prefixFlagBits.operandSizeOverride |
  prefixFlagBits.rep |
  prefixFlagBits.repne;
const prefixBucketCount = prefixFlagMask + 1;

const prefixes: PrefixModel = {
  byByte: buildPrefixTable(),
  flagBits: prefixFlagBits,
  flagMask: prefixFlagMask
};
const forms = buildInstructionForms(X86_32_CORE.instructions);

export const X86_32_DECODE_MODEL: X86DecodeModel = {
  instructionLengthLimit: X86_32_CORE.instructionLengthLimit,
  prefixes,
  opcodeRoot: buildOpcodeTree(forms),
  addressForms: buildModRm32(),
  forms
};

function buildOpcodeTree(forms: readonly InstructionForm[]): OpcodeNode {
  const root = mutableOpcodeNode();
  const leaves = new Map<MutableDecodeOpcodeNode, MutableDecodeOpcodeLeaf>();

  for (const form of forms) {
    let node = root;

    for (const byte of form.opcode) {
      assert(!leaves.has(node), `${form.id} extends an existing opcode form`);
      node.next[byte] ??= mutableOpcodeNode();
      node = node.next[byte];
    }

    assert(
      !node.next.some((next) => next !== undefined),
      `${form.id} prefixes an existing opcode form`
    );
    const leaf = leaves.get(node) ?? {
      opcodeLength: form.opcode.length,
      formsByPrefix: Array.from({ length: prefixBucketCount }, () => [])
    };

    leaves.set(node, leaf);
    addFormToLeaf(leaf, form);
  }

  for (const [node, leaf] of leaves) {
    node.leaf = {
      opcodeLength: leaf.opcodeLength,
      byPrefix: leaf.formsByPrefix.map(buildCandidate)
    };
  }
  return root;
}

function addFormToLeaf(
  leaf: MutableDecodeOpcodeLeaf,
  form: InstructionForm
): void {
  const prefixIndex = prefixFlagsFor(form.instruction);
  const forms = leaf.formsByPrefix[prefixIndex];

  assert(forms !== undefined, `missing prefix bucket for ${form.id}`);

  if (form.modrm === undefined) {
    assert(forms.length === 0, `ambiguous opcode/prefix form: ${form.id}`);
  } else {
    assert(
      forms.every((candidate) => candidate.modrm !== undefined),
      `opcode mixes ModRM and plain forms: ${form.id}`
    );
  }
  forms.push(form);
}

function buildCandidate(forms: readonly InstructionForm[]): DecodeCandidate {
  const first = forms[0];

  if (first === undefined) {
    return { kind: "empty" };
  }
  if (first.modrm === undefined) {
    assert(forms.length === 1, `ambiguous opcode/prefix form: ${first.id}`);
    return { kind: "plain", form: first };
  }
  const byByte = new Array<InstructionForm | undefined>(256);

  for (const form of forms) {
    assert(
      form.modrm !== undefined,
      `opcode mixes ModRM and plain forms: ${form.id}`
    );
    for (let byte = 0; byte <= 0xff; byte += 1) {
      if (form.modrm.acceptedBytes[byte] !== true) {
        continue;
      }
      assert(
        byByte[byte] === undefined,
        `ambiguous ModRM byte 0x${byte.toString(16).padStart(2, "0")} for ${form.id}`
      );
      byByte[byte] = form;
    }
  }
  return {
    kind: "modRm",
    formSelection: deriveModRmFormSelection(byByte)
  };
}

function mutableOpcodeNode(): MutableDecodeOpcodeNode {
  return {
    leaf: undefined,
    next: new Array<MutableDecodeOpcodeNode | undefined>(256)
  };
}

function prefixFlagsFor(instruction: InstructionSpec): number {
  let flags = instruction.prefixes?.operandSize === "override"
    ? prefixFlagBits.operandSizeOverride
    : 0;

  switch (instruction.prefixes?.rep) {
    case undefined:
      return flags;
    case "rep":
      flags |= prefixFlagBits.rep;
      return flags;
    case "repne":
      flags |= prefixFlagBits.repne;
      return flags;
  }
}

function buildPrefixTable(): readonly (PrefixEffect | undefined)[] {
  const byByte = new Array<PrefixEffect | undefined>(256);

  for (const [byte, segment] of segmentOverridePrefixSegments) {
    byByte[byte] = { kind: "segment", value: segment };
  }
  byByte[operandSizeOverridePrefixByte] = {
    kind: "operandSize",
    value: "override"
  };
  byByte[repPrefixByte] = { kind: "repeat", value: "rep" };
  byByte[repnePrefixByte] = { kind: "repeat", value: "repne" };
  return byByte;
}
