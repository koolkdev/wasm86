import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { CellRef } from "#compiler/refs/cell.js";
import type {
  DecodeOperand,
  InstructionForm,
  SegmentSelection
} from "#core/decoder/model/types.js";
import {
  dynamicMemSegment,
  immDynamicBinding,
  memBinding,
  memDynamicBaseBinding,
  memOffsetBinding,
  regBinding,
  regDynamicBinding,
  segmentBinding,
  segmentDynamicBinding,
  staticMemSegment,
  type MemSegmentBinding,
  type OperandBinding
} from "#core/instruction/bindings.js";
import { registerAliasByIndex } from "#core/registers.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import type {
  DecodedMemoryAddress
} from "./address.js";
import type { SegmentOverrideState } from "./prefixes.js";
import { InstructionByteStream } from "./stream.js";

export type DecodedRm =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "register"; registerIndex: ValueId }>
  | DecodedMemoryAddress;

type OperandDecoderOptions = Readonly<{
  instructionStart: ValueId;
  stream: InstructionByteStream;
  segmentOverride: SegmentOverrideState;
  modRmByte: CellRef;
}>;

export class OperandDecoder {
  readonly #instructionStart: ValueId;
  readonly #stream: InstructionByteStream;
  readonly #segmentOverride: SegmentOverrideState;
  readonly #modRmByte: CellRef;

  constructor(options: OperandDecoderOptions) {
    this.#instructionStart = options.instructionStart;
    this.#stream = options.stream;
    this.#segmentOverride = options.segmentOverride;
    this.#modRmByte = options.modRmByte;
  }

  buildBindings(
    region: RegionBuilder,
    form: InstructionForm,
    rm: DecodedRm
  ): readonly OperandBinding[] {
    return form.operands.map((operand) =>
      this.#buildBinding(region, form, operand, rm)
    );
  }

  #buildBinding(
    region: RegionBuilder,
    form: InstructionForm,
    operand: DecodeOperand,
    rm: DecodedRm
  ): OperandBinding {
    switch (operand.kind) {
      case "modrm.reg": {
        assert(form.modrm !== undefined, `${form.id} has no ModRM byte`);
        const modRmByte = region.read(this.#modRmByte);

        return regDynamicBinding(region.values.binary(
          "and",
          region.values.binary("shr_u", modRmByte, region.values.const(3)),
          region.values.const(0b111)
        ));
      }
      case "modrm.sreg": {
        assert(form.modrm !== undefined, `${form.id} has no ModRM byte`);
        const modRmByte = region.read(this.#modRmByte);
        const encodedIndex = region.values.binary(
          "and",
          region.values.binary("shr_u", modRmByte, region.values.const(3)),
          region.values.const(0b111)
        );

        return segmentDynamicBinding(region.switch(
          encodedIndex,
          operand.registers.map((segment, match) => ({
            match,
            build: (arm) => arm.values.const(segmentRegisterIndex(segment))
          })),
          (invalid) => invalid.values.unreachable()
        ));
      }
      case "modrm.rm":
        return this.#rmBinding(form, operand, rm);
      case "opcode.reg":
        assert(
          form.opcodeLowBits !== undefined,
          `${form.id} has no opcode register bits`
        );
        return regBinding(
          registerAliasByIndex(operand.width, form.opcodeLowBits).name
        );
      case "implicit.reg":
        return regBinding(operand.alias.name);
      case "implicit.sreg":
        return segmentBinding(operand.reg);
      case "implicit.mem":
        return memBinding({
          base: operand.base,
          index: undefined,
          scale: 1,
          disp: operand.disp
        }, this.#segmentBinding(region, operand.segment));
      case "moffs":
        return memOffsetBinding(
          this.#stream.readEncoded(region, operand.address),
          this.#segmentBinding(region, operand.segment)
        );
      case "immediate":
        return immDynamicBinding(
          this.#stream.readEncoded(region, operand.value)
        );
      case "relative": {
        const displacement = this.#stream.readEncoded(
          region,
          operand.displacement
        );
        const nextEip = region.values.binary(
          "add",
          this.#instructionStart,
          this.#stream.offset(region)
        );
        const target = region.values.binary("add", nextEip, displacement);

        return immDynamicBinding(
          operand.width === 16
            ? region.values.binary("and", target, region.values.const(0xffff))
            : target
        );
      }
    }
  }

  #rmBinding(
    form: InstructionForm,
    operand: Extract<DecodeOperand, { kind: "modrm.rm" }>,
    rm: DecodedRm
  ): OperandBinding {
    switch (rm.kind) {
      case "register":
        assert(
          operand.form === "registerOrMemory",
          "memory-only operand selected the register instruction path"
        );
        return regDynamicBinding(rm.registerIndex);
      case "baseLess":
        return memOffsetBinding(
          rm.offset,
          dynamicMemSegment(rm.segmentIndex)
        );
      case "dynamicBase":
        return memDynamicBaseBinding(
          rm.baseRegisterIndex,
          rm.offset,
          dynamicMemSegment(rm.segmentIndex)
        );
      case "none":
        assert(false, `${form.id} omitted its R/M binding`);
    }
  }

  #segmentBinding(
    region: RegionBuilder,
    selection: SegmentSelection
  ): MemSegmentBinding {
    switch (selection.kind) {
      case "fixed":
        return staticMemSegment(selection.segment);
      case "overrideOrDefault":
        return dynamicMemSegment(this.#segmentValue(region, selection));
    }
  }

  #segmentValue(
    region: RegionBuilder,
    selection: Extract<SegmentSelection, { kind: "overrideOrDefault" }>
  ): ValueId {
    return region.values.select(
      region.read(this.#segmentOverride.present),
      region.read(this.#segmentOverride.registerIndex),
      region.values.const(segmentRegisterIndex(selection.defaultSegment))
    );
  }
}
