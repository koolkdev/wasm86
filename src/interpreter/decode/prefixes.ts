import { assert } from "#common/assert.js";
import { Integer, integer, i32, u8, type I32Value } from "#compiler/function/values.js";
import { VariableRef } from "#compiler/function/storage.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { PrefixEffect } from "#instructions/decoder/model/types.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { RegionBuilder, SwitchControlArm } from "#compiler/function/builder/region.js";
import { InstructionByteStream } from "./stream.js";

export type SegmentOverrideState = Readonly<{
  present: VariableRef<(typeof Integer)[1]>;
  registerIndex: VariableRef<(typeof Integer)[8]>;
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
  readonly #flags: VariableRef<(typeof Integer)[32]>;
  readonly #firstOpcodeByte: VariableRef<(typeof Integer)[8]>;
  readonly #mode: PrefixDecodeMode;

  constructor(region: RegionBuilder, stream: InstructionByteStream, mode: PrefixDecodeMode) {
    const zero = i32(0);
    const absent = integer(1, 0);

    this.#stream = stream;
    this.#mode = mode;
    this.#flags = region.variable(zero);
    this.#firstOpcodeByte = region.variable(u8(0));
    this.segmentOverride = {
      present: region.variable(absent),
      registerIndex: region.variable(u8(0))
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

  flags(region: RegionBuilder): I32Value {
    return region.read(this.#flags);
  }

  firstOpcodeByte(region: RegionBuilder): Integer<8> {
    return region.read(this.#firstOpcodeByte);
  }

  #guardDirectPrefixLimit(region: RegionBuilder, fallback: ExactInstructionFallback): void {
    region.if(this.#stream.offset(region).unsigned.gt(maximumDirectPrefixCount), fallback, {
      hint: "unlikely"
    });
  }

  #apply(region: RegionBuilder, effect: PrefixEffect): void {
    const flagBits = X86_32_DECODE_MODEL.prefixes.flagBits;

    switch (effect.kind) {
      case "operandSize":
        region.write(this.#flags, region.read(this.#flags).or(flagBits.operandSizeOverride));
        return;
      case "repeat": {
        const repeatMask = flagBits.rep | flagBits.repne;
        const cleared = region.read(this.#flags).and(~repeatMask >>> 0);

        region.write(
          this.#flags,
          cleared.or(effect.value === "rep" ? flagBits.rep : flagBits.repne)
        );
        return;
      }
      case "segment":
        region.write(this.segmentOverride.present, integer(1, 1));
        region.write(this.segmentOverride.registerIndex, u8(segmentRegisterIndex(effect.value)));
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
