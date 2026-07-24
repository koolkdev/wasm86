import type { ValueId } from "#compiler/ir/values/types.js";
import { VariableRef } from "#compiler/ir/variable.js";
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
  type OperandBinding,
  type SegmentBindingSelection
} from "#core/instruction/bindings.js";
import { registerAliasByIndex } from "#core/registers.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
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
  modRmByte: VariableRef;
}>;

export class OperandDecoder {
  readonly #instructionStart: ValueId;
  readonly #stream: InstructionByteStream;
  readonly #segmentOverride: SegmentOverrideState;
  readonly #modRmByte: VariableRef;

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
        const modRmByte = region.read(this.#modRmByte);

        return regDynamicBinding(region.values.binary(
          "and",
          region.values.binary("shr_u", modRmByte, region.values.const(3)),
          region.values.const(0b111)
        ));
      }
      case "modrm.sreg": {
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
        return this.#rmBinding(region, rm);
      case "opcode.reg":
        return regBinding(
          registerAliasByIndex(operand.width, form.opcodeLowBits!).name
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
    region: RegionBuilder,
    rm: DecodedRm
  ): OperandBinding {
    switch (rm.kind) {
      case "register":
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
        return regDynamicBinding(region.values.unreachable());
    }
  }

  #segmentBinding(
    region: RegionBuilder,
    selection: SegmentSelection
  ): SegmentBindingSelection {
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
