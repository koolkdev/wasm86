import { Integer, select, u8, unreachable, type I32Value } from "#compiler/function/values.js";
import { VariableRef } from "#compiler/function/storage.js";
import type {
  DecodeOperand,
  InstructionForm,
  SegmentSelection
} from "#instructions/decoder/model/types.js";
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
} from "#instructions/lowering/bindings.js";
import { registerAliasByIndex } from "#core/registers.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { DecodedMemoryAddress } from "./address.js";
import type { SegmentOverrideState } from "./prefixes.js";
import { InstructionByteStream } from "./stream.js";

export type DecodedRm =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "register"; registerIndex: Integer<8> }>
  | DecodedMemoryAddress;

type OperandDecoderOptions = Readonly<{
  instructionStart: I32Value;
  stream: InstructionByteStream;
  segmentOverride: SegmentOverrideState;
  modRmByte: VariableRef<(typeof Integer)[8]>;
}>;

export class OperandDecoder {
  readonly #instructionStart: I32Value;
  readonly #stream: InstructionByteStream;
  readonly #segmentOverride: SegmentOverrideState;
  readonly #modRmByte: VariableRef<(typeof Integer)[8]>;

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
    return form.operands.map((operand) => this.#buildBinding(region, form, operand, rm));
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
        const registerIndex = modRmByte.unsigned.shr(3).and(0b111);

        return regDynamicBinding(registerIndex);
      }
      case "modrm.sreg": {
        const modRmByte = region.read(this.#modRmByte);
        const encodedIndex = modRmByte.unsigned.shr(3).and(0b111);

        return segmentDynamicBinding(
          region.switch(
            encodedIndex,
            operand.registers.map((segment, match) => ({
              match,
              build: () => u8(segmentRegisterIndex(segment))
            })),
            () => unreachable(8)
          )
        );
      }
      case "modrm.rm":
        return this.#rmBinding(rm);
      case "opcode.reg":
        return regBinding(registerAliasByIndex(operand.width, form.opcodeLowBits!).name);
      case "implicit.reg":
        return regBinding(operand.alias.name);
      case "implicit.sreg":
        return segmentBinding(operand.reg);
      case "implicit.mem":
        return memBinding(
          {
            base: operand.base,
            index: undefined,
            scale: 1,
            disp: operand.disp
          },
          this.#segmentBinding(region, operand.segment)
        );
      case "moffs":
        return memOffsetBinding(
          this.#stream.readEncoded(region, operand.address),
          this.#segmentBinding(region, operand.segment)
        );
      case "immediate":
        return immDynamicBinding(this.#stream.readEncoded(region, operand.value));
      case "relative": {
        const displacement = this.#stream.readEncoded(region, operand.displacement);
        const nextEip = this.#instructionStart.add(this.#stream.offset(region));
        const target = nextEip.add(displacement);

        return immDynamicBinding(operand.width === 16 ? target.and(0xffff) : target);
      }
    }
  }

  #rmBinding(rm: DecodedRm): OperandBinding {
    switch (rm.kind) {
      case "register":
        return regDynamicBinding(rm.registerIndex);
      case "baseLess":
        return memOffsetBinding(rm.offset, dynamicMemSegment(rm.segmentIndex));
      case "dynamicBase":
        return memDynamicBaseBinding(
          rm.baseRegisterIndex,
          rm.offset,
          dynamicMemSegment(rm.segmentIndex)
        );
      case "none":
        return regDynamicBinding(unreachable(8));
    }
  }

  #segmentBinding(region: RegionBuilder, selection: SegmentSelection): SegmentBindingSelection {
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
  ): Integer<8> {
    return select(
      region.read(this.#segmentOverride.present),
      region.read(this.#segmentOverride.registerIndex),
      u8(segmentRegisterIndex(selection.defaultSegment))
    );
  }
}
