import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { u32 } from "#x86/numeric.js";
import { X86_32_CORE } from "#x86/index.js";
import {
  expandInstructionSpec,
  instructionReadsModRm
} from "#x86/schema/builders.js";
import type {
  ExpandedInstructionSpec,
  MemOperandType,
  ModRmMatch,
  OperandSizePrefixMode,
  OperandSpec,
  Reg3,
  RegOperandType,
  RmOperandType
} from "#x86/schema/types.js";
import { registerAlias, registerAliasByIndex } from "#x86/registers.js";
import type { MemOperand, OperandWidth } from "#x86/types.js";
import { signedImm8, signedImm32 } from "./immediate.js";
import { decodeModRmAddressing, rm32ModRmByteLengthAt, type ModRmRm } from "./modrm.js";
import { buildOpcodeDispatch, opcodeLeaf, type OpcodeDispatchLeaf } from "./opcode-dispatch.js";
import {
  instructionTooLongFault,
  IsaDecodeError,
  maxX86InstructionLength,
  readAvailableBytes,
  readRawBytes,
  readU16LE,
  readU32LE,
  type IsaDecodeReader
} from "./reader.js";
import type { IsaDecodedInstruction, IsaDecodeResult, IsaOperandBinding } from "./types.js";

type DecodedModRm = Readonly<{
  mod: Reg3;
  regField: Reg3;
  rmField: Reg3;
  rm: ModRmRm;
  byteLength: number;
}>;

type DecodedPrefixes = Readonly<{
  operandSize: OperandSizePrefixMode;
  byteLength: number;
}>;

type CandidateDecode =
  | Readonly<{ kind: "match"; instruction: IsaDecodedInstruction }>
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "unsupported"; length: number }>;

type DispatchedCandidates = Readonly<{
  candidates: readonly ExpandedInstructionSpec<SemanticTemplate>[];
  modrm: DecodedModRm | undefined;
  unsupportedLength: number;
}>;

const EXPANDED_INSTRUCTIONS: readonly ExpandedInstructionSpec<SemanticTemplate>[] =
  X86_32_CORE.instructions.flatMap((spec) => expandInstructionSpec(spec));
const OPCODE_DISPATCH_ROOT = buildOpcodeDispatch(EXPANDED_INSTRUCTIONS);

export function decodeIsaInstructionFromReader(
  reader: IsaDecodeReader,
  address: number
): IsaDecodeResult {
  const instructionReader = maxLengthDecodeReader(reader, address);
  const prefixes = decodePrefixes(instructionReader, address);
  const opcodeAddress = address + prefixes.byteLength;
  const lookup = opcodeLeaf(OPCODE_DISPATCH_ROOT, instructionReader, opcodeAddress);

  if (lookup.kind === "unsupported") {
    return unsupported(instructionReader, address, prefixes.byteLength + lookup.length);
  }

  const dispatched = dispatchCandidates(
    instructionReader,
    opcodeAddress,
    prefixes.byteLength,
    prefixes.operandSize,
    lookup.leaf
  );

  for (const expanded of dispatched.candidates) {
    const decoded = decodeCandidate(instructionReader, address, opcodeAddress, expanded, dispatched.modrm);

    if (decoded.kind === "match") {
      return { kind: "ok", instruction: decoded.instruction };
    }

    if (decoded.kind === "unsupported") {
      return unsupported(instructionReader, address, decoded.length);
    }
  }

  return unsupported(instructionReader, address, dispatched.unsupportedLength);
}

function maxLengthDecodeReader(reader: IsaDecodeReader, address: number): IsaDecodeReader {
  return {
    readU8: (eip) => {
      const offset = eip - address;

      if (Number.isInteger(offset) && offset >= maxX86InstructionLength) {
        throw new IsaDecodeError(
          instructionTooLongFault(address, readAvailableBytes(reader, address, maxX86InstructionLength))
        );
      }

      return reader.readU8(eip);
    }
  };
}

function decodeCandidate(
  reader: IsaDecodeReader,
  address: number,
  opcodeAddress: number,
  expanded: ExpandedInstructionSpec<SemanticTemplate>,
  dispatchedModRm: DecodedModRm | undefined
): CandidateDecode {
  const spec = expanded.spec;
  let cursor = opcodeAddress + expanded.opcode.length;

  const modrm = instructionReadsModRm(spec) ? dispatchedModRm ?? decodeModRm(reader, cursor) : undefined;

  if (modrm !== undefined) {
    if (!modRmMatches(spec.modrm?.match, modrm)) {
      return { kind: "skip" };
    }

    cursor += modrm.byteLength;
  }

  const operands: IsaOperandBinding[] = [];

  for (const operand of spec.operands ?? []) {
    const decoded = decodeOperand(reader, cursor, expanded, modrm, operand);

    if (decoded.kind === "unsupported") {
      return { kind: "unsupported", length: cursor - address };
    }

    operands.push(decoded.binding);
    cursor = decoded.cursor;
  }

  const length = cursor - address;

  return {
    kind: "match",
    instruction: {
      spec,
      address,
      length,
      nextEip: u32(address + length),
      operands,
      raw: readRawBytes(reader, address, cursor)
    }
  };
}

function decodeOperand(
  reader: IsaDecodeReader,
  cursor: number,
  expanded: ExpandedInstructionSpec<SemanticTemplate>,
  modrm: DecodedModRm | undefined,
  operand: OperandSpec
):
  | Readonly<{ kind: "ok"; binding: IsaOperandBinding; cursor: number }>
  | Readonly<{ kind: "unsupported" }> {
  switch (operand.kind) {
    case "modrm.reg":
      return modrm === undefined
        ? { kind: "unsupported" }
        : { kind: "ok", binding: registerBinding(operandWidth(operand.type), modrm.regField), cursor };
    case "modrm.rm":
      if (modrm === undefined) {
        return { kind: "unsupported" };
      }

      return decodeModRmRmOperand(modrm.rm, operand, cursor);
    case "opcode.reg":
      return expanded.opcodeLowBits === undefined
        ? { kind: "unsupported" }
        : { kind: "ok", binding: registerBinding(operandWidth(operand.type), expanded.opcodeLowBits), cursor };
    case "implicit.reg":
      return { kind: "ok", binding: { kind: "reg", alias: registerAlias(operand.reg) }, cursor };
    case "moffs":
      return {
        kind: "ok",
        binding: { kind: "mem", accessWidth: operand.width, scale: 1, disp: readU32LE(reader, cursor) },
        cursor: cursor + 4
      };
    case "imm": {
      const immediate = readImmediate(reader, cursor, operand.width, operand.extension);
      const semanticWidth = operand.semanticWidth ?? operand.width;

      return {
        kind: "ok",
        binding: immediate.extension === undefined
          ? { kind: "imm", value: immediate.value, encodedWidth: operand.width, semanticWidth }
          : {
            kind: "imm",
            value: immediate.value,
            encodedWidth: operand.width,
            semanticWidth,
            extension: immediate.extension
          },
        cursor: cursor + immediate.byteLength
      };
    }
    case "rel": {
      const relative = readRelative(reader, cursor, operand.width);
      const nextEip = u32(cursor + relative.byteLength);

      return {
        kind: "ok",
        binding: {
          kind: "relTarget",
          width: operand.width,
          displacement: relative.displacement,
          target: relativeTarget(nextEip, relative.displacement, operand.width)
        },
        cursor: cursor + relative.byteLength
      };
    }
  }
}

function decodeModRm(reader: IsaDecodeReader, address: number): DecodedModRm {
  const value = reader.readU8(address);
  const decoded = decodeModRmAddressing(reader, address);

  return {
    mod: reg3(value >>> 6),
    regField: reg3(value >>> 3),
    rmField: reg3(value),
    rm: decoded.rm,
    byteLength: rm32ModRmByteLengthAt(reader, address)
  };
}

function modRmMatches(match: ModRmMatch | undefined, modrm: DecodedModRm): boolean {
  return (
    reg3Matches(match?.mod, modrm.mod) &&
    reg3Matches(match?.reg, modrm.regField) &&
    reg3Matches(match?.rm, modrm.rmField)
  );
}

function reg3Matches(expected: Reg3 | undefined, actual: Reg3): boolean {
  return expected === undefined || expected === actual;
}

function readImmediate(
  reader: IsaDecodeReader,
  address: number,
  width: 8 | 16 | 32,
  extension: "sign" | undefined
): Readonly<{ value: number; byteLength: number; extension?: "sign" }> {
  switch (width) {
    case 8: {
      const value = reader.readU8(address);
      const extended = extension === "sign" ? u32(signedImm8(value)) : value;

      return extension === undefined
        ? { value: extended, byteLength: 1 }
        : { value: extended, byteLength: 1, extension };
    }
    case 16: {
      const value = readU16LE(reader, address);
      const extended = extension === "sign" && (value & 0x8000) !== 0 ? u32(value - 0x1_0000) : value;

      return extension === undefined
        ? { value: extended, byteLength: 2 }
        : { value: extended, byteLength: 2, extension };
    }
    case 32:
      return { value: readU32LE(reader, address), byteLength: 4 };
  }
}

function readRelative(
  reader: IsaDecodeReader,
  address: number,
  width: 8 | 16 | 32
): Readonly<{ displacement: number; byteLength: number }> {
  switch (width) {
    case 8:
      return { displacement: signedImm8(reader.readU8(address)), byteLength: 1 };
    case 16: {
      const value = readU16LE(reader, address);

      return {
        displacement: (value & 0x8000) === 0 ? value : value - 0x1_0000,
        byteLength: 2
      };
    }
    case 32:
      return { displacement: signedImm32(readU32LE(reader, address)), byteLength: 4 };
  }
}

function relativeTarget(nextEip: number, displacement: number, width: 8 | 16 | 32): number {
  const target = u32(nextEip + displacement);

  return width === 16 ? target & 0xffff : target;
}

function registerBinding(width: OperandWidth, index: number): IsaOperandBinding {
  return { kind: "reg", alias: registerAliasByIndex(width, index) };
}

function decodeModRmRmOperand(
  rm: ModRmRm,
  operand: Extract<OperandSpec, { kind: "modrm.rm" }>,
  cursor: number
): Readonly<{ kind: "ok"; binding: IsaOperandBinding; cursor: number }> | Readonly<{ kind: "unsupported" }> {
  const width = operandWidth(operand.type);

  switch (rm.kind) {
    case "reg":
      return isMemoryOnlyOperand(operand.type)
        ? { kind: "unsupported" }
        : { kind: "ok", binding: registerBinding(width, rm.index), cursor };
    case "mem":
      return {
        kind: "ok",
        binding: {
          kind: "mem",
          accessWidth: width,
          ...rm.address
        } satisfies MemOperand,
        cursor
      };
  }
}

function operandWidth(type: RegOperandType | RmOperandType | MemOperandType): OperandWidth {
  switch (type) {
    case "r8":
    case "rm8":
    case "m8":
      return 8;
    case "r16":
    case "rm16":
    case "m16":
      return 16;
    case "r32":
    case "rm32":
    case "m32":
      return 32;
  }
}

function isMemoryOnlyOperand(type: RmOperandType | MemOperandType): type is MemOperandType {
  switch (type) {
    case "m8":
    case "m16":
    case "m32":
      return true;
    case "rm8":
    case "rm16":
    case "rm32":
      return false;
  }
}

function decodePrefixes(reader: IsaDecodeReader, address: number): DecodedPrefixes {
  let byteLength = 0;
  let operandSize: OperandSizePrefixMode = "default";

  while (reader.readU8(address + byteLength) === 0x66) {
    operandSize = "override";
    byteLength += 1;
  }

  return { operandSize, byteLength };
}

function unsupported(reader: IsaDecodeReader, address: number, length: number): IsaDecodeResult {
  const raw = readRawBytes(reader, address, address + length);
  const unsupportedByte = raw[0];
  const result = {
    kind: "unsupported" as const,
    address,
    length,
    raw
  };

  return unsupportedByte === undefined ? result : { ...result, unsupportedByte };
}

function reg3(value: number): Reg3 {
  return (value & 0b111) as Reg3;
}

function dispatchCandidates(
  reader: IsaDecodeReader,
  opcodeAddress: number,
  prefixByteLength: number,
  operandSize: OperandSizePrefixMode,
  leaf: OpcodeDispatchLeaf
): DispatchedCandidates {
  const candidates = leaf.operandSize[operandSize];

  switch (candidates.kind) {
    case "empty":
      return {
        candidates: [],
        modrm: undefined,
        unsupportedLength: prefixByteLength + leaf.opcodeLength
      };
    case "noModRm":
      return {
        candidates: candidates.noModRmCandidates,
        modrm: undefined,
        unsupportedLength: prefixByteLength + leaf.opcodeLength
      };
    case "modRm": {
      const modrm = decodeModRm(reader, opcodeAddress + leaf.opcodeLength);

      return {
        candidates: candidates.modRmByReg[modrm.regField] ?? [],
        modrm,
        unsupportedLength: prefixByteLength + leaf.opcodeLength + modrm.byteLength
      };
    }
  }
}
