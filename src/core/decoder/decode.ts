import { u32 } from "#core/numeric.js";
import { X86_32_CORE } from "#core/index.js";
import {
  expandInstructionSpec,
  instructionReadsModRm,
  type ExpandedInstructionSpec,
  type MemOperandType,
  type ModRmMatch,
  type OperandSizePrefixMode,
  type OperandSpec,
  type Reg3,
  type RegOperandType,
  type RmOperandType
} from "#core/instructions/spec.js";
import { registerAlias, registerAliasByIndex } from "#core/registers.js";
import {
  operandSizeOverridePrefixByte,
  repnePrefixByte,
  repPrefixByte,
  segmentOverridePrefixSegments,
  type RepeatPrefix
} from "#core/prefixes.js";
import { defaultSegmentForBase } from "#core/segments.js";
import { segmentRegisters, type MemOperand, type MemoryOperandWidth, type OperandWidth, type SegmentRegister } from "#core/types.js";
import { signedImm8, signedImm32 } from "./immediate.js";
import { decodeModRmAddressing, rm32ModRmByteLengthAt, type ModRmRm } from "./modrm.js";
import { buildOpcodeDispatch, opcodeLeaf, type OpcodeDispatchLeaf } from "./opcode-dispatch.js";
import { prefixFlagsFor } from "./prefix-flags.js";
import {
  instructionTooLongFault,
  IsaDecodeError,
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

type CandidateDecode =
  | Readonly<{ kind: "match"; instruction: IsaDecodedInstruction }>
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "unsupported"; length: number }>;

type DispatchedCandidates = Readonly<{
  candidates: readonly ExpandedInstructionSpec[];
  modrm: DecodedModRm | undefined;
  unsupportedLength: number;
}>;

const EXPANDED_INSTRUCTIONS: readonly ExpandedInstructionSpec[] =
  X86_32_CORE.instructions.flatMap((spec) => expandInstructionSpec(spec));
const OPCODE_DISPATCH_ROOT = buildOpcodeDispatch(EXPANDED_INSTRUCTIONS);
const instructionLengthLimit = X86_32_CORE.instructionLengthLimit;

export function decodeIsaInstructionFromReader(
  reader: IsaDecodeReader,
  address: number
): IsaDecodeResult {
  return new InstructionDecoder(reader, address).decode();
}

class InstructionDecoder {
  private readonly reader: IsaDecodeReader;
  private operandSize: OperandSizePrefixMode = "default";
  private repPrefix: RepeatPrefix | undefined;
  private segmentOverride: SegmentRegister | undefined;
  private prefixByteLength = 0;

  constructor(private readonly source: IsaDecodeReader, private readonly address: number) {
    this.reader = { readU8: (eip) => this.readU8(eip) };
  }

  decode(): IsaDecodeResult {
    this.decodePrefixes();

    if (this.prefixByteLength >= instructionLengthLimit) {
      return this.unsupported(this.prefixByteLength);
    }

    const opcodeAddress = this.address + this.prefixByteLength;
    const lookup = opcodeLeaf(OPCODE_DISPATCH_ROOT, this.reader, opcodeAddress);

    if (lookup.kind === "unsupported") {
      return this.unsupported(this.prefixByteLength + lookup.length);
    }

    const dispatched = this.dispatchCandidates(opcodeAddress, lookup.leaf);

    for (const expanded of dispatched.candidates) {
      const decoded = this.decodeCandidate(opcodeAddress, expanded, dispatched.modrm);

      if (decoded.kind === "match") {
        return { kind: "ok", instruction: decoded.instruction };
      }

      if (decoded.kind === "unsupported") {
        return this.unsupported(decoded.length);
      }
    }

    return this.unsupported(dispatched.unsupportedLength);
  }

  private decodePrefixes(): void {
    while (
      this.prefixByteLength < instructionLengthLimit &&
      this.consumePrefix(this.readU8(this.address + this.prefixByteLength))
    ) {}
  }

  private consumePrefix(value: number): boolean {
    if (value === operandSizeOverridePrefixByte) {
      this.operandSize = "override";
      return this.consumePrefixByte();
    }

    if (value === repPrefixByte) {
      this.repPrefix = "rep";
      return this.consumePrefixByte();
    }

    if (value === repnePrefixByte) {
      this.repPrefix = "repne";
      return this.consumePrefixByte();
    }

    const segment = segmentOverridePrefixSegments.get(value);

    if (segment === undefined) {
      return false;
    }

    this.segmentOverride = segment;
    return this.consumePrefixByte();
  }

  private consumePrefixByte(): true {
    this.prefixByteLength += 1;
    return true;
  }

  private decodeCandidate(
    opcodeAddress: number,
    expanded: ExpandedInstructionSpec,
    dispatchedModRm: DecodedModRm | undefined
  ): CandidateDecode {
    const spec = expanded.spec;
    let cursor = opcodeAddress + expanded.opcode.length;

    const modrm = instructionReadsModRm(spec) ? dispatchedModRm ?? this.decodeModRm(cursor) : undefined;

    if (modrm !== undefined) {
      if (!InstructionDecoder.modRmMatches(spec.modrm?.match, modrm)) {
        return { kind: "skip" };
      }

      cursor += modrm.byteLength;
    }

    const operands: IsaOperandBinding[] = [];

    for (const operand of spec.operands ?? []) {
      const decoded = this.decodeOperand(cursor, expanded, modrm, operand);

      if (decoded.kind === "unsupported") {
        return { kind: "unsupported", length: cursor - this.address };
      }

      operands.push(decoded.binding);
      cursor = decoded.cursor;
    }

    const length = cursor - this.address;
    this.assertInstructionLength(cursor);

    return {
      kind: "match",
      instruction: {
        spec,
        address: this.address,
        length,
        nextEip: u32(this.address + length),
        operands,
        raw: readRawBytes(this.reader, this.address, cursor)
      }
    };
  }

  private decodeOperand(
    cursor: number,
    expanded: ExpandedInstructionSpec,
    modrm: DecodedModRm | undefined,
    operand: OperandSpec
  ):
    | Readonly<{ kind: "ok"; binding: IsaOperandBinding; cursor: number }>
    | Readonly<{ kind: "unsupported" }> {
    switch (operand.kind) {
      case "modrm.reg":
        return modrm === undefined
          ? { kind: "unsupported" }
          : {
            kind: "ok",
            binding: InstructionDecoder.registerBinding(InstructionDecoder.registerOperandWidth(operand.type), modrm.regField),
            cursor
          };
      case "modrm.sreg": {
        const binding = modrm === undefined ? undefined : InstructionDecoder.segmentBinding(modrm.regField);

        return binding === undefined ? { kind: "unsupported" } : { kind: "ok", binding, cursor };
      }
      case "modrm.rm":
        if (modrm === undefined) {
          return { kind: "unsupported" };
        }

        return this.decodeModRmRmOperand(modrm.rm, operand, cursor);
      case "opcode.reg":
        return expanded.opcodeLowBits === undefined
          ? { kind: "unsupported" }
          : {
            kind: "ok",
            binding: InstructionDecoder.registerBinding(
              InstructionDecoder.registerOperandWidth(operand.type),
              expanded.opcodeLowBits
            ),
            cursor
          };
      case "implicit.reg":
        return { kind: "ok", binding: { kind: "reg", alias: registerAlias(operand.reg) }, cursor };
      case "implicit.sreg":
        return { kind: "ok", binding: { kind: "segment", reg: operand.reg }, cursor };
      case "implicit.mem":
        return {
          kind: "ok",
          binding: ({
            kind: "mem",
            accessWidth: operand.width,
            segment: operand.segment ?? this.segmentOverride ?? defaultSegmentForBase(operand.base),
            base: operand.base,
            index: undefined,
            scale: 1,
            disp: operand.disp
          } satisfies MemOperand),
          cursor
        };
      case "moffs":
        return {
          kind: "ok",
          binding: {
            kind: "mem",
            accessWidth: operand.width,
            segment: this.segmentOverride ?? "ds",
            base: undefined,
            index: undefined,
            scale: 1,
            disp: readU32LE(this.reader, cursor)
          },
          cursor: cursor + 4
        };
      case "imm": {
        const immediate = InstructionDecoder.readImmediate(this.reader, cursor, operand.width, operand.extension);
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
        const relative = InstructionDecoder.readRelative(this.reader, cursor, operand.width);
        const nextEip = u32(cursor + relative.byteLength);

        return {
          kind: "ok",
          binding: {
            kind: "relTarget",
            width: operand.width,
            displacement: relative.displacement,
            target: InstructionDecoder.relativeTarget(nextEip, relative.displacement, operand.width)
          },
          cursor: cursor + relative.byteLength
        };
      }
    }
  }

  private decodeModRm(address: number): DecodedModRm {
    const value = this.reader.readU8(address);
    const decoded = decodeModRmAddressing(this.reader, address);

    return {
      mod: InstructionDecoder.reg3(value >>> 6),
      regField: InstructionDecoder.reg3(value >>> 3),
      rmField: InstructionDecoder.reg3(value),
      rm: decoded.rm,
      byteLength: rm32ModRmByteLengthAt(this.reader, address)
    };
  }

  private decodeModRmRmOperand(
    rm: ModRmRm,
    operand: Extract<OperandSpec, { kind: "modrm.rm" }>,
    cursor: number
  ): Readonly<{ kind: "ok"; binding: IsaOperandBinding; cursor: number }> | Readonly<{ kind: "unsupported" }> {
    switch (rm.kind) {
      case "reg":
        return InstructionDecoder.isMemoryOnlyOperand(operand.type)
          ? { kind: "unsupported" }
          : {
            kind: "ok",
            binding: InstructionDecoder.registerBinding(InstructionDecoder.rmRegisterWidth(operand.type), rm.index),
            cursor
          };
      case "mem":
        return {
          kind: "ok",
          binding: {
            kind: "mem",
            accessWidth: InstructionDecoder.rmMemoryWidth(operand.type),
            ...rm.address,
            segment: this.segmentOverride ?? rm.address.segment
          } satisfies MemOperand,
          cursor
        };
    }
  }

  private unsupported(length: number): IsaDecodeResult {
    this.assertInstructionLength(this.address + length);
    return InstructionDecoder.unsupported(this.reader, this.address, length);
  }

  private readU8(eip: number): number {
    const offset = eip - this.address;

    if (offset >= instructionLengthLimit) {
      this.throwInstructionTooLong();
    }

    return this.source.readU8(eip);
  }

  private assertInstructionLength(end: number): void {
    if (end - this.address > instructionLengthLimit) {
      this.throwInstructionTooLong();
    }
  }

  private throwInstructionTooLong(): never {
    throw new IsaDecodeError(
      instructionTooLongFault(
        this.address,
        instructionLengthLimit,
        readAvailableBytes(this.source, this.address, instructionLengthLimit)
      )
    );
  }

  private dispatchCandidates(opcodeAddress: number, leaf: OpcodeDispatchLeaf): DispatchedCandidates {
    const candidates = leaf.prefixFlags[prefixFlagsFor({
      operandSize: this.operandSize,
      ...(this.repPrefix === undefined ? {} : { rep: this.repPrefix })
    })];

    if (candidates === undefined) {
      return {
        candidates: [],
        modrm: undefined,
        unsupportedLength: this.prefixByteLength + leaf.opcodeLength
      };
    }

    switch (candidates.kind) {
      case "empty":
        return {
          candidates: [],
          modrm: undefined,
          unsupportedLength: this.prefixByteLength + leaf.opcodeLength
        };
      case "noModRm":
        return {
          candidates: candidates.noModRmCandidates,
          modrm: undefined,
          unsupportedLength: this.prefixByteLength + leaf.opcodeLength
        };
      case "modRm": {
        const modrm = this.decodeModRm(opcodeAddress + leaf.opcodeLength);

        return {
          candidates: candidates.modRmByReg[modrm.regField] ?? [],
          modrm,
          unsupportedLength: this.prefixByteLength + leaf.opcodeLength + modrm.byteLength
        };
      }
    }
  }

  private static modRmMatches(match: ModRmMatch | undefined, modrm: DecodedModRm): boolean {
    return (
      InstructionDecoder.reg3Matches(match?.mod, modrm.mod) &&
      InstructionDecoder.reg3Matches(match?.reg, modrm.regField) &&
      InstructionDecoder.reg3Matches(match?.rm, modrm.rmField)
    );
  }

  private static reg3Matches(expected: Reg3 | undefined, actual: Reg3): boolean {
    return expected === undefined || expected === actual;
  }

  private static readImmediate(
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

  private static readRelative(
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

  private static relativeTarget(nextEip: number, displacement: number, width: 8 | 16 | 32): number {
    const target = u32(nextEip + displacement);

    return width === 16 ? target & 0xffff : target;
  }

  private static registerBinding(width: OperandWidth, index: number): IsaOperandBinding {
    return { kind: "reg", alias: registerAliasByIndex(width, index) };
  }

  private static segmentBinding(index: number): IsaOperandBinding | undefined {
    const reg = segmentRegisters[index];

    return reg === undefined ? undefined : { kind: "segment", reg };
  }

  private static registerOperandWidth(type: RegOperandType): OperandWidth {
    switch (type) {
      case "r8":
        return 8;
      case "r16":
        return 16;
      case "r32":
        return 32;
    }
  }

  private static rmRegisterWidth(type: RmOperandType): OperandWidth {
    switch (type) {
      case "rm8":
        return 8;
      case "rm16":
        return 16;
      case "rm32":
      case "r32_m16":
        return 32;
    }
  }

  private static rmMemoryWidth(type: RmOperandType | MemOperandType): MemoryOperandWidth {
    switch (type) {
      case "rm8":
      case "m8":
        return 8;
      case "rm16":
      case "m16":
      case "r32_m16":
        return 16;
      case "rm32":
      case "m32":
        return 32;
      case "m64":
        return 64;
    }
  }

  private static isMemoryOnlyOperand(type: RmOperandType | MemOperandType): type is MemOperandType {
    switch (type) {
      case "m8":
      case "m16":
      case "m32":
      case "m64":
        return true;
      case "rm8":
      case "rm16":
      case "rm32":
      case "r32_m16":
        return false;
    }
  }

  private static unsupported(reader: IsaDecodeReader, address: number, length: number): IsaDecodeResult {
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

  private static reg3(value: number): Reg3 {
    return (value & 0b111) as Reg3;
  }
}
