import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { VariableRef } from "#compiler/ir/variable.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { PrefixEffect } from "#instructions/decoder/model/types.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder, SwitchControlArm } from "#compiler/ir/builder/region.js";
import { InstructionByteStream } from "./stream.js";

export type SegmentOverrideState = Readonly<{
  present: VariableRef;
  registerIndex: VariableRef;
}>;

export type ExactInstructionFallback = (region: RegionBuilder) => void;

type PrefixDecodeMode =
  | Readonly<{ kind: "exact" }>
  | Readonly<{
      kind: "direct";
      fallbackToExact: ExactInstructionFallback;
    }>;

const maximumDirectPrefixCount =
  X86_32_DECODE_MODEL.instructionLengthLimit - X86_32_DECODE_MODEL.maximumUnprefixedByteLength;

assert(
  maximumDirectPrefixCount >= 0,
  "an unprefixed instruction may exceed the architectural length limit"
);

export class PrefixDecoder {
  readonly segmentOverride: SegmentOverrideState;
  readonly #stream: InstructionByteStream;
  readonly #flags: VariableRef;
  readonly #firstOpcodeByte: VariableRef;
  readonly #mode: PrefixDecodeMode;

  constructor(region: RegionBuilder, stream: InstructionByteStream, mode: PrefixDecodeMode) {
    const zero = region.values.const(0);

    this.#stream = stream;
    this.#mode = mode;
    this.#flags = region.variable(zero);
    this.#firstOpcodeByte = region.variable(zero);
    this.segmentOverride = {
      present: region.variable(zero),
      registerIndex: region.variable(zero)
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
            // Direct reads deliberately omit per-read bounds checks. Exact
            // mode already enforces the architectural limit on every read.
            if (this.#mode.kind === "direct") {
              this.#guardDirectPrefixLimit(prefix, this.#mode.fallbackToExact);
            }
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

  #guardDirectPrefixLimit(region: RegionBuilder, fallback: ExactInstructionFallback): void {
    const values = region.values;

    region.if(
      values.compare(
        32,
        "gt_u",
        this.#stream.offset(region),
        values.const(maximumDirectPrefixCount)
      ),
      fallback,
      { hint: "unlikely" }
    );
  }

  #apply(region: RegionBuilder, effect: PrefixEffect): void {
    const values = region.values;
    const bits = X86_32_DECODE_MODEL.prefixes.flagBits;

    switch (effect.kind) {
      case "operandSize":
        region.write(
          this.#flags,
          values.binary("or", region.read(this.#flags), values.const(bits.operandSizeOverride))
        );
        return;
      case "repeat": {
        const repeatMask = bits.rep | bits.repne;
        const cleared = values.binary(
          "and",
          region.read(this.#flags),
          values.const(~repeatMask >>> 0)
        );

        region.write(
          this.#flags,
          values.binary("or", cleared, values.const(effect.value === "rep" ? bits.rep : bits.repne))
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
