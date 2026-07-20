import { assert } from "#common/assert.js";
import {
  generalProtection,
  invalidOpcode,
  type CpuException
} from "#core/exceptions.js";
import { u32 } from "#core/numeric.js";
import { registerAliasByIndex } from "#core/registers.js";
import type {
  EffectiveAddress,
  MemOperand,
  SegmentRegister
} from "#core/types.js";
import { X86_32_DECODE_MODEL } from "./model/index.js";
import type {
  AddressBase,
  DecodeOperand,
  EncodedValue,
  InstructionForm,
  OpcodeLeaf,
  PrefixEffect,
  SegmentSelection
} from "./model/types.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeReader,
  IsaDecodeResult,
  IsaOperandBinding
} from "./types.js";

type SelectedForm = Readonly<{
  form: InstructionForm;
  modRmByte: number | undefined;
}>;

type DecodedRm =
  | Readonly<{ kind: "reg"; index: number }>
  | Readonly<{ kind: "mem"; address: EffectiveAddress }>;

class CpuExceptionSignal {
  constructor(readonly exception: CpuException<number>) {
  }
}

class IsaDecodeCursor {
  readonly #raw: number[] = [];

  constructor(
    private readonly source: IsaDecodeReader,
    readonly instructionStart: number
  ) {}

  get offset(): number {
    return this.#raw.length;
  }

  readByte(relativeOffset: number): number {
    assert(
      Number.isInteger(relativeOffset) && relativeOffset >= 0,
      `invalid instruction byte offset: ${relativeOffset}`
    );

    if (relativeOffset >= X86_32_DECODE_MODEL.instructionLengthLimit) {
      throw new CpuExceptionSignal(generalProtection(0));
    }

    const cached = this.#raw[relativeOffset];

    if (cached !== undefined) {
      return cached;
    }

    assert(
      relativeOffset === this.#raw.length,
      `instruction decoder skipped byte offset ${this.#raw.length} before ${relativeOffset}`
    );
    const fetched = this.source.readU8(u32(this.instructionStart + relativeOffset));

    if (fetched.kind === "exception") {
      throw new CpuExceptionSignal(fetched.exception);
    }
    const value = fetched.value;

    assert(
      Number.isInteger(value) && value >= 0 && value <= 0xff,
      `instruction byte out of range at offset ${relativeOffset}: ${value}`
    );
    this.#raw.push(value);
    return value;
  }

  snapshotRaw(): readonly number[] {
    return this.#raw.slice();
  }
}

export function decodeIsaInstructionFromReader(
  reader: IsaDecodeReader,
  address: number
): IsaDecodeResult {
  return decodeIsaInstruction(new IsaDecodeCursor(reader, address));
}

function decodeIsaInstruction(cursor: IsaDecodeCursor): IsaDecodeResult {
  try {
    return new NumericDecodeEvaluator(cursor).decode();
  } catch (error: unknown) {
    if (error instanceof CpuExceptionSignal) {
      return {
        kind: "cpuException",
        exception: error.exception,
        instructionStart: cursor.instructionStart,
        raw: cursor.snapshotRaw()
      };
    }

    throw error;
  }
}

class NumericDecodeEvaluator {
  private prefixFlags = 0;
  private segmentOverride: SegmentRegister | undefined;

  constructor(private readonly cursor: IsaDecodeCursor) {}

  decode(): IsaDecodeResult {
    const opcodeOffset = this.decodePrefixes();
    const leaf = this.lookupOpcode(opcodeOffset);

    if (leaf === undefined) {
      return this.invalidOpcode();
    }

    const selected = this.selectForm(leaf, opcodeOffset);

    if (selected === undefined) {
      return this.invalidOpcode();
    }

    return {
      kind: "instruction",
      instruction: this.decodeInstruction(selected)
    };
  }

  private decodePrefixes(): number {
    for (;;) {
      const offset = this.cursor.offset;
      const value = this.cursor.readByte(offset);
      const effect = X86_32_DECODE_MODEL.prefixes.byByte[value];

      if (effect === undefined) {
        return offset;
      }

      this.applyPrefix(effect);
    }
  }

  private applyPrefix(effect: PrefixEffect): void {
    const { flagBits } = X86_32_DECODE_MODEL.prefixes;

    switch (effect.kind) {
      case "operandSize":
        this.prefixFlags |= flagBits.operandSizeOverride;
        return;
      case "repeat":
        this.prefixFlags &= ~(flagBits.rep | flagBits.repne);
        this.prefixFlags |= effect.value === "rep"
          ? flagBits.rep
          : flagBits.repne;
        return;
      case "segment":
        this.segmentOverride = effect.value;
        return;
    }
  }

  private lookupOpcode(opcodeOffset: number): OpcodeLeaf | undefined {
    let node = X86_32_DECODE_MODEL.opcodeRoot;

    for (let depth = 0; ; depth += 1) {
      const byte = this.cursor.readByte(opcodeOffset + depth);
      const next = node.next[byte];

      if (next === undefined) {
        return undefined;
      }

      if (next.leaf !== undefined) {
        return next.leaf;
      }

      node = next;
    }
  }

  private selectForm(
    leaf: OpcodeLeaf,
    opcodeOffset: number
  ): SelectedForm | undefined {
    const prefixIndex = this.prefixFlags & X86_32_DECODE_MODEL.prefixes.flagMask;
    const candidates = leaf.byPrefix[prefixIndex];

    assert(candidates !== undefined, `missing prefix bucket ${prefixIndex}`);

    switch (candidates.kind) {
      case "empty":
        return undefined;
      case "plain":
        return { form: candidates.form, modRmByte: undefined };
      case "modRm": {
        const modRmOffset = opcodeOffset + leaf.opcodeLength;
        const modRmByte = this.cursor.readByte(modRmOffset);
        const form = candidates.byByte[modRmByte];

        return form === undefined ? undefined : { form, modRmByte };
      }
    }
  }

  private decodeInstruction(selected: SelectedForm): IsaDecodedInstruction {
    const decodedRm = selected.modRmByte === undefined
      ? undefined
      : this.decodeRm(selected.modRmByte);
    const operands = selected.form.operands.map((operand) =>
      this.decodeOperand(selected.form, operand, selected.modRmByte, decodedRm)
    );
    const length = this.cursor.offset;

    return {
      spec: selected.form.instruction,
      address: this.cursor.instructionStart,
      length,
      nextEip: u32(this.cursor.instructionStart + length),
      operands,
      raw: this.cursor.snapshotRaw()
    };
  }

  private decodeRm(modRmByte: number): DecodedRm {
    const mod = modRmByte >>> 6;
    const rm = modRmByte & 0b111;
    const mode = X86_32_DECODE_MODEL.addressForms.modes[mod];

    assert(mode !== undefined, `missing ModRM mode ${mod}`);

    if (mode.kind === "register") {
      return { kind: "reg", index: rm };
    }

    const address = mode.rm[rm];

    assert(address !== undefined, `missing ModRM R/M case ${mod}:${rm}`);

    if (address.kind === "base") {
      return {
        kind: "mem",
        address: this.decodeEffectiveAddress(address.address, undefined, 1)
      };
    }

    const sib = this.cursor.readByte(this.cursor.offset);
    const scaleField = sib >>> 6;
    const indexField = (sib >>> 3) & 0b111;
    const baseField = sib & 0b111;
    const base = address.bases[baseField];
    const index = X86_32_DECODE_MODEL.addressForms.sibIndexes[indexField];
    const encodedScale = X86_32_DECODE_MODEL.addressForms.sibScales[scaleField];

    assert(base !== undefined, `missing SIB base case ${baseField}`);
    assert(encodedScale !== undefined, `missing SIB scale case ${scaleField}`);
    return {
      kind: "mem",
      address: this.decodeEffectiveAddress(
        base,
        index,
        index === undefined ? 1 : encodedScale
      )
    };
  }

  private decodeEffectiveAddress(
    address: AddressBase,
    index: EffectiveAddress["index"],
    scale: EffectiveAddress["scale"]
  ): EffectiveAddress {
    return {
      segment: address.defaultSegment,
      base: address.base,
      index,
      scale,
      disp: this.readDisplacement(address)
    };
  }

  private readDisplacement(address: AddressBase): number {
    if (address.displacement.byteLength === 0) {
      return 0;
    }

    return this.readEncodedValue({
      byteLength: address.displacement.byteLength,
      signed: address.displacement.signed
    });
  }

  private decodeOperand(
    form: InstructionForm,
    operand: DecodeOperand,
    modRmByte: number | undefined,
    decodedRm: DecodedRm | undefined
  ): IsaOperandBinding {
    switch (operand.kind) {
      case "modrm.reg":
        assert(modRmByte !== undefined, `${form.id} has no ModRM byte for reg operand`);
        return {
          kind: "reg",
          alias: registerAliasByIndex(operand.width, (modRmByte >>> 3) & 0b111)
        };
      case "modrm.sreg": {
        assert(modRmByte !== undefined, `${form.id} has no ModRM byte for segment operand`);
        const reg = operand.registers[(modRmByte >>> 3) & 0b111];

        assert(reg !== undefined, `${form.id} selected an invalid segment register`);
        return { kind: "segment", reg };
      }
      case "modrm.rm":
        assert(decodedRm !== undefined, `${form.id} has no decoded R/M operand`);

        if (decodedRm.kind === "reg") {
          assert(
            operand.form === "registerOrMemory",
            `${form.id} selected a register for a memory-only operand`
          );
          return {
            kind: "reg",
            alias: registerAliasByIndex(operand.registerWidth, decodedRm.index)
          };
        }

        return {
          kind: "mem",
          accessWidth: operand.memoryWidth,
          ...decodedRm.address,
          segment: this.segmentOverride ?? decodedRm.address.segment
        } satisfies MemOperand;
      case "opcode.reg":
        assert(form.opcodeLowBits !== undefined, `${form.id} has no opcode register bits`);
        return {
          kind: "reg",
          alias: registerAliasByIndex(operand.width, form.opcodeLowBits)
        };
      case "implicit.reg":
        return { kind: "reg", alias: operand.alias };
      case "implicit.sreg":
        return { kind: "segment", reg: operand.reg };
      case "implicit.mem":
        return {
          kind: "mem",
          accessWidth: operand.accessWidth,
          segment: this.selectSegment(operand.segment),
          base: operand.base,
          index: undefined,
          scale: 1,
          disp: operand.disp
        } satisfies MemOperand;
      case "moffs":
        return {
          kind: "mem",
          accessWidth: operand.accessWidth,
          segment: this.selectSegment(operand.segment),
          base: undefined,
          index: undefined,
          scale: 1,
          disp: this.readEncodedValue(operand.address)
        } satisfies MemOperand;
      case "immediate": {
        const rawValue = this.readEncodedValue(operand.value);
        const value = operand.extension === "sign" ? u32(rawValue) : rawValue;
        const binding = {
          kind: "imm" as const,
          value,
          encodedWidth: operand.encodedWidth,
          semanticWidth: operand.semanticWidth
        };

        return operand.extension === "none"
          ? binding
          : { ...binding, extension: operand.extension };
      }
      case "relative": {
        const displacement = this.readEncodedValue(operand.displacement);
        const nextEip = u32(this.cursor.instructionStart + this.cursor.offset);
        const target = u32(nextEip + displacement);

        return {
          kind: "relTarget",
          width: operand.width,
          displacement,
          target: operand.width === 16 ? target & 0xffff : target
        };
      }
    }
  }

  private selectSegment(selection: SegmentSelection): SegmentRegister {
    switch (selection.kind) {
      case "fixed":
        return selection.segment;
      case "overrideOrDefault":
        return this.segmentOverride ?? selection.defaultSegment;
    }
  }

  private readEncodedValue(encoded: EncodedValue): number {
    let value = 0;

    for (let index = 0; index < encoded.byteLength; index += 1) {
      value += this.cursor.readByte(this.cursor.offset) * 2 ** (index * 8);
    }

    value = u32(value);

    if (!encoded.signed) {
      return value;
    }

    const bits = encoded.byteLength * 8;
    const sign = 2 ** (bits - 1);

    return value < sign ? value : value - 2 ** bits;
  }

  private invalidOpcode(): IsaDecodeResult {
    return {
      kind: "cpuException",
      exception: invalidOpcode(),
      instructionStart: this.cursor.instructionStart,
      raw: this.cursor.snapshotRaw()
    };
  }
}
