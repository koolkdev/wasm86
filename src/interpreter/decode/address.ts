import {
  Integer,
  i32,
  select,
  u8,
  type BitValue,
  type I32Value
} from "#compiler/function/values.js";
import { VariableRef } from "#compiler/function/storage.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { AddressBase, Displacement } from "#instructions/decoder/model/types.js";
import { reg32Index } from "#core/registers.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { StateAccess } from "#core/state/access.js";
import type { SegmentRegister } from "#core/types.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { SegmentOverrideState } from "./prefixes.js";
import { InstructionByteStream } from "./stream.js";

const sibIndexes = X86_32_DECODE_MODEL.addressForms.sibIndexes;
const sibNoIndexEncoding = sibIndexes.findIndex((register) => register === undefined);
const dynamicBaseAddressKind = 0;
const baseLessAddressKind = 1;
const invalidAddressKind = -1;

export type DecodedMemoryAddress =
  | Readonly<{
      kind: "baseLess";
      offset: I32Value;
      segmentIndex: Integer<8>;
    }>
  | Readonly<{
      kind: "dynamicBase";
      // Kept as an index so the instruction reads the base after any earlier
      // architectural update, such as POP incrementing ESP.
      baseRegisterIndex: Integer<8>;
      offset: I32Value;
      segmentIndex: Integer<8>;
    }>;

type ModRmAddressDecoderOptions = Readonly<{
  stream: InstructionByteStream;
  stateAccess: StateAccess;
  segmentOverride: SegmentOverrideState;
  unreachable(region: RegionBuilder): void;
}>;

export class ModRmAddressDecoder {
  readonly #stream: InstructionByteStream;
  readonly #stateAccess: StateAccess;
  readonly #segmentOverride: SegmentOverrideState;
  readonly #unreachable: (region: RegionBuilder) => void;
  readonly #addressKind: VariableRef<(typeof Integer)[32]>;
  readonly #baseRegisterIndex: VariableRef<(typeof Integer)[8]>;
  readonly #offset: VariableRef<(typeof Integer)[32]>;
  readonly #segmentIndex: VariableRef<(typeof Integer)[8]>;

  constructor(region: RegionBuilder, options: ModRmAddressDecoderOptions) {
    const invalid = i32(-1);
    const invalidIndex = u8(0xff);

    this.#stream = options.stream;
    this.#stateAccess = options.stateAccess;
    this.#segmentOverride = options.segmentOverride;
    this.#unreachable = options.unreachable;
    this.#addressKind = region.variable(i32(invalidAddressKind));
    this.#baseRegisterIndex = region.variable(invalidIndex);
    this.#offset = region.variable(invalid);
    this.#segmentIndex = region.variable(invalidIndex);
  }

  decode(region: RegionBuilder, modRmByte: Integer<8>): void {
    const mode = modRmByte.unsigned.shr(6);

    region.switchControl(
      mode,
      X86_32_DECODE_MODEL.addressForms.modes.flatMap((modeModel, match) =>
        modeModel.kind === "register"
          ? []
          : [
              {
                matches: [match],
                build: (modeArm: RegionBuilder) => {
                  const encodedRm = modRmByte.and(0b111);

                  modeArm.switchControl(
                    encodedRm,
                    modeModel.rm.map((address, rm) => ({
                      matches: [rm],
                      build: (rmArm) => {
                        if (address.kind === "base") {
                          this.#writeAddress(rmArm, address.address, i32(0));
                          return;
                        }
                        this.#decodeSib(rmArm, address.bases);
                      }
                    })),
                    this.#unreachable
                  );
                }
              }
            ]
      ),
      this.#unreachable
    );
  }

  withAddress(
    region: RegionBuilder,
    build: (region: RegionBuilder, address: DecodedMemoryAddress) => void
  ): void {
    region.switchControl(
      region.read(this.#addressKind),
      [
        {
          matches: [dynamicBaseAddressKind],
          build: (dynamicBase) =>
            build(dynamicBase, {
              kind: "dynamicBase",
              baseRegisterIndex: dynamicBase.read(this.#baseRegisterIndex),
              offset: dynamicBase.read(this.#offset),
              segmentIndex: dynamicBase.read(this.#segmentIndex)
            })
        },
        {
          matches: [baseLessAddressKind],
          build: (baseLess) =>
            build(baseLess, {
              kind: "baseLess",
              offset: baseLess.read(this.#offset),
              segmentIndex: baseLess.read(this.#segmentIndex)
            })
        }
      ],
      this.#unreachable
    );
  }

  #decodeSib(region: RegionBuilder, bases: readonly AddressBase[]): void {
    const sib = this.#stream.readByte(region);
    const scaleShift = sib.unsigned.shr(6);
    const indexField = sib.unsigned.shr(3).and(0b111);
    const baseField = sib.and(0b111);
    const state = this.#stateAccess.forRegion(region);
    const indexValue = state.read(state.dynamicGpr(indexField, 32));
    const scaledIndex = select(
      indexField.eq(sibNoIndexEncoding),
      i32(0),
      indexValue.shl(scaleShift)
    );
    const baseLessEncodings = bases.flatMap((base, encoding) =>
      base.base === undefined ? [encoding] : []
    );
    const baseLessEncoding = baseLessEncodings[0];

    if (baseLessEncoding === undefined) {
      this.#writeDynamicSibAddress(region, bases, undefined, baseField, scaledIndex);
      return;
    }
    const baseLess = bases[baseLessEncoding]!;

    region.if(
      baseField.eq(baseLessEncoding),
      (withoutBase) => this.#writeAddress(withoutBase, baseLess, scaledIndex),
      {
        elseBuild: (withBase) =>
          this.#writeDynamicSibAddress(withBase, bases, baseLessEncoding, baseField, scaledIndex)
      }
    );
  }

  #writeDynamicSibAddress(
    region: RegionBuilder,
    bases: readonly AddressBase[],
    excludedEncoding: number | undefined,
    baseField: Integer<8>,
    scaledIndex: I32Value
  ): void {
    const plan = prepareDynamicSibPlan(bases, excludedEncoding);
    const defaultSegmentIndex = select(
      this.#matchesAnyEncoding(baseField, plan.matchedEncodings),
      u8(segmentRegisterIndex(plan.matchedSegment)),
      u8(segmentRegisterIndex(plan.fallbackSegment))
    );
    const displacement =
      plan.displacement.byteLength === 0
        ? i32(0)
        : this.#stream.readEncoded(region, {
            byteLength: plan.displacement.byteLength,
            signed: plan.displacement.signed
          });

    region.write(this.#baseRegisterIndex, baseField);
    region.write(this.#offset, scaledIndex.add(displacement));
    region.write(this.#segmentIndex, this.#selectSegmentIndex(region, defaultSegmentIndex));
    region.write(this.#addressKind, i32(dynamicBaseAddressKind));
  }

  #writeAddress(region: RegionBuilder, address: AddressBase, scaledIndex: I32Value): void {
    const displacement =
      address.displacement.byteLength === 0
        ? i32(0)
        : this.#stream.readEncoded(region, {
            byteLength: address.displacement.byteLength,
            signed: address.displacement.signed
          });

    region.write(this.#offset, scaledIndex.add(displacement));
    region.write(
      this.#segmentIndex,
      this.#selectSegmentIndex(region, u8(segmentRegisterIndex(address.defaultSegment)))
    );
    if (address.base === undefined) {
      region.write(this.#addressKind, i32(baseLessAddressKind));
      return;
    }
    region.write(this.#baseRegisterIndex, u8(reg32Index(address.base)));
    region.write(this.#addressKind, i32(dynamicBaseAddressKind));
  }

  #selectSegmentIndex(region: RegionBuilder, defaultSegmentIndex: Integer<8>): Integer<8> {
    return select(
      region.read(this.#segmentOverride.present),
      region.read(this.#segmentOverride.registerIndex),
      defaultSegmentIndex
    );
  }

  #matchesAnyEncoding(value: Integer<8>, encodings: readonly number[]): BitValue {
    const first = encodings[0]!;
    let matches = value.eq(first);

    for (const encoding of encodings.slice(1)) {
      matches = matches.or(value.eq(encoding));
    }
    return matches;
  }
}

type DynamicSibPlan = Readonly<{
  displacement: Displacement;
  matchedSegment: SegmentRegister;
  matchedEncodings: readonly number[];
  fallbackSegment: SegmentRegister;
}>;

function prepareDynamicSibPlan(
  bases: readonly AddressBase[],
  excludedEncoding: number | undefined
): DynamicSibPlan {
  const dynamicBases = bases.flatMap((address, encoding) =>
    encoding === excludedEncoding ? [] : [{ address, encoding }]
  );
  const first = dynamicBases[0]!;

  const displacement = first.address.displacement;
  const encodingsBySegment = new Map<SegmentRegister, number[]>();

  for (const { address, encoding } of dynamicBases) {
    const encodings = encodingsBySegment.get(address.defaultSegment) ?? [];

    encodings.push(encoding);
    encodingsBySegment.set(address.defaultSegment, encodings);
  }
  const groups = [...encodingsBySegment].sort((left, right) => left[1].length - right[1].length);
  const compared = groups[0]!;
  const fallback = groups[1]!;

  return {
    displacement,
    matchedSegment: compared[0],
    matchedEncodings: compared[1],
    fallbackSegment: fallback[0]
  };
}
