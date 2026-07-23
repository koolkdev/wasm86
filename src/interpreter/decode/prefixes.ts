import type { ValueId } from "#compiler/ir/values/types.js";
import { CellRef } from "#compiler/ir/cell.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type { PrefixEffect } from "#core/decoder/model/types.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder, SwitchControlArm } from "#compiler/ir/builder/region.js";
import { InstructionByteStream } from "./stream.js";

export type SegmentOverrideState = Readonly<{
  present: CellRef;
  registerIndex: CellRef;
}>;

export class PrefixDecoder {
  readonly segmentOverride: SegmentOverrideState;
  readonly #stream: InstructionByteStream;
  readonly #flags: CellRef;
  readonly #firstOpcodeByte: CellRef;

  constructor(region: RegionBuilder, stream: InstructionByteStream) {
    const zero = region.values.const(0);

    this.#stream = stream;
    this.#flags = region.cell(zero);
    this.#firstOpcodeByte = region.cell(zero);
    this.segmentOverride = {
      present: region.cell(zero),
      registerIndex: region.cell(zero)
    };
  }

  decode(region: RegionBuilder): void {
    region.loop([], (body) => {
      const byte = this.#stream.readByte(body);

      body.write(this.#firstOpcodeByte, byte);
      body.switchControl(
        byte,
        prefixCases.map(({ matches, effect }): SwitchControlArm => ({
          matches,
          build: (prefix) => {
            this.#apply(prefix, effect);
            prefix.loopContinue([]);
          }
        })),
        // The first non-prefix byte leaves the loop as the opcode byte.
        () => {}
      );
    });
  }

  flags(region: RegionBuilder): ValueId {
    return region.read(this.#flags);
  }

  firstOpcodeByte(region: RegionBuilder): ValueId {
    return region.read(this.#firstOpcodeByte);
  }

  #apply(region: RegionBuilder, effect: PrefixEffect): void {
    const values = region.values;
    const bits = X86_32_DECODE_MODEL.prefixes.flagBits;

    switch (effect.kind) {
      case "operandSize":
        region.write(
          this.#flags,
          values.binary(
            "or",
            region.read(this.#flags),
            values.const(bits.operandSizeOverride)
          )
        );
        return;
      case "repeat": {
        const repeatMask = bits.rep | bits.repne;
        const cleared = values.binary(
          "and",
          region.read(this.#flags),
          values.const((~repeatMask) >>> 0)
        );

        region.write(
          this.#flags,
          values.binary(
            "or",
            cleared,
            values.const(effect.value === "rep" ? bits.rep : bits.repne)
          )
        );
        return;
      }
      case "segment":
        region.write(this.segmentOverride.present, values.const(1));
        region.write(
          this.segmentOverride.registerIndex,
          values.const(segmentRegisterIndex(effect.value))
        );
        return;
    }
  }
}

type PrefixCase = Readonly<{
  matches: readonly number[];
  effect: PrefixEffect;
}>;

const prefixCases: readonly PrefixCase[] = (() => {
  const cases: PrefixCase[] = [];

  X86_32_DECODE_MODEL.prefixes.byByte.forEach((effect, byte) => {
    if (effect !== undefined) {
      cases.push({ matches: [byte], effect });
    }
  });
  return cases;
})();
