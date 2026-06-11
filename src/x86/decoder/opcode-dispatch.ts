import type { SemanticTemplate } from "#ir/model/types.js";
import { instructionReadsModRm } from "#x86/schema/builders.js";
import type { ExpandedInstructionSpec, OperandSizePrefixMode, Reg3 } from "#x86/schema/types.js";
import type { IsaDecodeReader } from "./reader.js";

export type OpcodeDispatchCandidateSet = Readonly<{
  kind: "empty" | "noModRm" | "modRm";
  noModRmCandidates: readonly ExpandedInstructionSpec<SemanticTemplate>[];
  modRmByReg: readonly (readonly ExpandedInstructionSpec<SemanticTemplate>[])[];
}>;

export type OpcodeDispatchLeaf = Readonly<{
  opcodeLength: number;
  operandSize: Readonly<Record<OperandSizePrefixMode, OpcodeDispatchCandidateSet>>;
}>;

export type OpcodeDispatchNode = Readonly<{
  leaf: OpcodeDispatchLeaf | undefined;
  next: readonly (OpcodeDispatchNode | undefined)[];
}>;

export type OpcodeLookup =
  | Readonly<{ kind: "leaf"; leaf: OpcodeDispatchLeaf }>
  | Readonly<{ kind: "unsupported"; length: number }>;

type MutableOpcodeDispatchCandidateSet = {
  kind: "empty" | "noModRm" | "modRm";
  noModRmCandidates: ExpandedInstructionSpec<SemanticTemplate>[];
  modRmByReg: ExpandedInstructionSpec<SemanticTemplate>[][];
};

type MutableOpcodeDispatchLeaf = {
  opcodeLength: number;
  operandSize: Record<OperandSizePrefixMode, MutableOpcodeDispatchCandidateSet>;
};

type MutableOpcodeDispatchNode = {
  leaf: MutableOpcodeDispatchLeaf | undefined;
  next: (MutableOpcodeDispatchNode | undefined)[];
};

// The dispatchable byte values at a node, in ascending order.
export function dispatchBytes(node: OpcodeDispatchNode): number[] {
  const bytes: number[] = [];

  for (let byte = 0; byte <= 0xff; byte += 1) {
    if (node.next[byte] !== undefined) {
      bytes.push(byte);
    }
  }

  return bytes;
}

export function buildOpcodeDispatch(
  instructions: readonly ExpandedInstructionSpec<SemanticTemplate>[]
): OpcodeDispatchNode {
  const root = opcodeDispatchNode();

  for (const instruction of instructions) {
    let node = root;

    for (const byte of instruction.opcode) {
      node.next[byte] ??= opcodeDispatchNode();
      node = node.next[byte];
    }

    node.leaf ??= opcodeDispatchLeaf(instruction.opcode.length);
    addOpcodeCandidate(node.leaf, instruction);
  }

  return root;
}

export function opcodeLeaf(
  root: OpcodeDispatchNode,
  reader: IsaDecodeReader,
  eip: number
): OpcodeLookup {
  let node = root;

  for (let cursor = eip, length = 1; ; cursor += 1, length += 1) {
    const next = node.next[reader.readU8(cursor)];

    if (next === undefined) {
      return { kind: "unsupported", length };
    }

    if (next.leaf !== undefined) {
      return { kind: "leaf", leaf: next.leaf };
    }

    node = next;
  }
}

function opcodeDispatchNode(): MutableOpcodeDispatchNode {
  return {
    leaf: undefined,
    next: new Array<MutableOpcodeDispatchNode | undefined>(256)
  };
}

function opcodeDispatchLeaf(opcodeLength: number): MutableOpcodeDispatchLeaf {
  return {
    opcodeLength,
    operandSize: {
      default: opcodeDispatchCandidateSet(),
      override: opcodeDispatchCandidateSet()
    }
  };
}

function opcodeDispatchCandidateSet(): MutableOpcodeDispatchCandidateSet {
  return {
    kind: "empty",
    noModRmCandidates: [],
    modRmByReg: Array.from({ length: 8 }, () => [])
  };
}

function addOpcodeCandidate(
  leaf: MutableOpcodeDispatchLeaf,
  instruction: ExpandedInstructionSpec<SemanticTemplate>
): void {
  const candidates = leaf.operandSize[instruction.spec.prefixes?.operandSize ?? "default"];

  if (!instructionReadsModRm(instruction.spec)) {
    useCandidateKind(candidates, "noModRm", instruction);
    candidates.noModRmCandidates.push(instruction);
    return;
  }

  useCandidateKind(candidates, "modRm", instruction);
  const regMatch = instruction.spec.modrm?.match?.reg;

  if (regMatch === undefined) {
    for (const bucket of candidates.modRmByReg) {
      bucket.push(instruction);
    }

    return;
  }

  addModRmRegCandidate(candidates, regMatch, instruction);
}

function useCandidateKind(
  candidates: MutableOpcodeDispatchCandidateSet,
  kind: "noModRm" | "modRm",
  instruction: ExpandedInstructionSpec<SemanticTemplate>
): void {
  if (candidates.kind === "empty") {
    candidates.kind = kind;
    return;
  }

  if (candidates.kind !== kind) {
    throw new Error(`opcode dispatch mixes ModRM and non-ModRM forms for ${instruction.spec.id}`);
  }
}

function addModRmRegCandidate(
  candidateSet: MutableOpcodeDispatchCandidateSet,
  reg: Reg3,
  instruction: ExpandedInstructionSpec<SemanticTemplate>
): void {
  const candidates = candidateSet.modRmByReg[reg];

  if (candidates === undefined) {
    throw new Error(`ModRM.reg dispatch bucket out of range: ${reg}`);
  }

  candidates.push(instruction);
}
