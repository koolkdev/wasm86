import { assert } from "#common/assert.js";
import { X86_32_CORE } from "#core/index.js";
import type { InstructionSpec } from "#core/isa/spec.js";
import {
  operandSizeOverridePrefixByte,
  repnePrefixByte,
  repPrefixByte,
  segmentOverridePrefixSegments
} from "#core/prefixes.js";
import type {
  DecodeCandidate,
  InstructionForm,
  OpcodeNode,
  PrefixEffect,
  PrefixModel,
  X86DecodeModel
} from "./types.js";
import { buildInstructionForms } from "./forms.js";
import { buildModRm32 } from "./modrm32.js";

type MutableDecodeOpcodeNode = {
  leaf: MutableDecodeOpcodeLeaf | undefined;
  next: (MutableDecodeOpcodeNode | undefined)[];
};

type MutableDecodeOpcodeLeaf = {
  opcodeLength: number;
  byPrefix: DecodeCandidate[];
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

  for (const form of forms) {
    let node = root;

    for (const byte of form.opcode) {
      assert(node.leaf === undefined, `${form.id} extends an existing opcode form`);
      node.next[byte] ??= mutableOpcodeNode();
      node = node.next[byte];
    }

    assert(
      !node.next.some((next) => next !== undefined),
      `${form.id} prefixes an existing opcode form`
    );
    node.leaf ??= {
      opcodeLength: form.opcode.length,
      byPrefix: Array.from(
        { length: prefixBucketCount },
        () => ({ kind: "empty" as const })
      )
    };
    addFormToLeaf(node.leaf, form);
  }

  return root;
}

function addFormToLeaf(
  leaf: MutableDecodeOpcodeLeaf,
  form: InstructionForm
): void {
  const prefixIndex = prefixFlagsFor(form.instruction);
  const candidates = leaf.byPrefix[prefixIndex];

  assert(candidates !== undefined, `missing prefix bucket for ${form.id}`);

  if (form.modrm === undefined) {
    assert(candidates.kind === "empty", `ambiguous opcode/prefix form: ${form.id}`);
    leaf.byPrefix[prefixIndex] = { kind: "plain", form };
    return;
  }

  const byByte = candidates.kind === "empty"
    ? new Array<InstructionForm | undefined>(256)
    : candidates.kind === "modRm"
      ? candidates.byByte as (InstructionForm | undefined)[]
      : undefined;

  assert(byByte !== undefined, `opcode mixes ModRM and plain forms: ${form.id}`);

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

  if (candidates.kind === "empty") {
    leaf.byPrefix[prefixIndex] = { kind: "modRm", byByte };
  }
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
