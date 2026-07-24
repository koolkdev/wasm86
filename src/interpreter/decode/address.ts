import type { ValueId } from "#compiler/ir/values/types.js";
import { VariableRef } from "#compiler/ir/variable.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type {
  AddressBase,
  Displacement
} from "#instructions/decoder/model/types.js";
import { reg32Index } from "#core/registers.js";
import { segmentRegisterIndex } from "#core/segments.js";
import type { StateAccess } from "#core/state/access.js";
import type { SegmentRegister } from "#core/types.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { SegmentOverrideState } from "./prefixes.js";
import { InstructionByteStream } from "./stream.js";

const sibIndexes = X86_32_DECODE_MODEL.addressForms.sibIndexes;
const sibNoIndexEncoding = sibIndexes.findIndex(
  (register) => register === undefined
);
const dynamicBaseAddressKind = 0;
const baseLessAddressKind = 1;
const invalidAddressKind = -1;

export type DecodedMemoryAddress =
  | Readonly<{
      kind: "baseLess";
      offset: ValueId;
      segmentIndex: ValueId;
    }>
  | Readonly<{
      kind: "dynamicBase";
      // Kept as an index so the instruction reads the base after any earlier
      // architectural update, such as POP incrementing ESP.
      baseRegisterIndex: ValueId;
      offset: ValueId;
      segmentIndex: ValueId;
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
  readonly #addressKind: VariableRef;
  readonly #baseRegisterIndex: VariableRef;
  readonly #offset: VariableRef;
  readonly #segmentIndex: VariableRef;

  constructor(region: RegionBuilder, options: ModRmAddressDecoderOptions) {
    const invalid = region.values.const(-1);

    this.#stream = options.stream;
    this.#stateAccess = options.stateAccess;
    this.#segmentOverride = options.segmentOverride;
    this.#unreachable = options.unreachable;
    this.#addressKind = region.variable(region.values.const(invalidAddressKind));
    this.#baseRegisterIndex = region.variable(invalid);
    this.#offset = region.variable(invalid);
    this.#segmentIndex = region.variable(invalid);
  }

  decode(region: RegionBuilder, modRmByte: ValueId): void {
    const mode = region.values.binary(
      "shr_u",
      modRmByte,
      region.values.const(6)
    );

    region.switchControl(
      mode,
      X86_32_DECODE_MODEL.addressForms.modes.flatMap((modeModel, match) =>
        modeModel.kind === "register" ? [] : [{
          matches: [match],
          build: (modeArm: RegionBuilder) => {
            const encodedRm = modeArm.values.binary(
              "and",
              modRmByte,
              modeArm.values.const(0b111)
            );

            modeArm.switchControl(
              encodedRm,
              modeModel.rm.map((address, rm) => ({
                matches: [rm],
                build: (rmArm) => {
                  if (address.kind === "base") {
                    this.#writeAddress(
                      rmArm,
                      address.address,
                      rmArm.values.const(0)
                    );
                    return;
                  }
                  this.#decodeSib(rmArm, address.bases);
                }
              })),
              this.#unreachable
            );
          }
        }]
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
          build: (dynamicBase) => build(dynamicBase, {
            kind: "dynamicBase",
            baseRegisterIndex: dynamicBase.read(this.#baseRegisterIndex),
            offset: dynamicBase.read(this.#offset),
            segmentIndex: dynamicBase.read(this.#segmentIndex)
          })
        },
        {
          matches: [baseLessAddressKind],
          build: (baseLess) => build(baseLess, {
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
    const scaleShift = region.values.binary(
      "shr_u",
      sib,
      region.values.const(6)
    );
    const indexField = region.values.binary(
      "and",
      region.values.binary("shr_u", sib, region.values.const(3)),
      region.values.const(0b111)
    );
    const baseField = region.values.binary(
      "and",
      sib,
      region.values.const(0b111)
    );
    const state = this.#stateAccess.bind(region);
    const indexValue = state.read(state.dynamicGpr(indexField, 32));
    const scaledIndex = region.values.select(
      region.values.compare(
        32,
        "eq",
        indexField,
        region.values.const(sibNoIndexEncoding)
      ),
      region.values.const(0),
      region.values.binary("shl", indexValue, scaleShift)
    );
    const baseLessEncodings = bases.flatMap((base, encoding) =>
      base.base === undefined ? [encoding] : []
    );
    const baseLessEncoding = baseLessEncodings[0];

    if (baseLessEncoding === undefined) {
      this.#writeDynamicSibAddress(
        region,
        bases,
        undefined,
        baseField,
        scaledIndex
      );
      return;
    }
    const baseLess = bases[baseLessEncoding]!;

    region.if(
      region.values.compare(
        32,
        "eq",
        baseField,
        region.values.const(baseLessEncoding)
      ),
      (withoutBase) => this.#writeAddress(withoutBase, baseLess, scaledIndex),
      {
        elseBuild: (withBase) => this.#writeDynamicSibAddress(
          withBase,
          bases,
          baseLessEncoding,
          baseField,
          scaledIndex
        )
      }
    );
  }

  #writeDynamicSibAddress(
    region: RegionBuilder,
    bases: readonly AddressBase[],
    excludedEncoding: number | undefined,
    baseField: ValueId,
    scaledIndex: ValueId
  ): void {
    const plan = prepareDynamicSibPlan(bases, excludedEncoding);
    const defaultSegmentIndex = region.values.select(
      this.#matchesAnyEncoding(
        region,
        baseField,
        plan.matchedEncodings
      ),
      region.values.const(segmentRegisterIndex(plan.matchedSegment)),
      region.values.const(segmentRegisterIndex(plan.fallbackSegment))
    );
    const displacement = plan.displacement.byteLength === 0
      ? region.values.const(0)
      : this.#stream.readEncoded(region, {
          byteLength: plan.displacement.byteLength,
          signed: plan.displacement.signed
        });

    region.write(this.#baseRegisterIndex, baseField);
    region.write(
      this.#offset,
      region.values.binary("add", scaledIndex, displacement)
    );
    region.write(
      this.#segmentIndex,
      this.#selectSegmentIndex(region, defaultSegmentIndex)
    );
    region.write(
      this.#addressKind,
      region.values.const(dynamicBaseAddressKind)
    );
  }

  #writeAddress(
    region: RegionBuilder,
    address: AddressBase,
    scaledIndex: ValueId
  ): void {
    const displacement = address.displacement.byteLength === 0
      ? region.values.const(0)
      : this.#stream.readEncoded(region, {
          byteLength: address.displacement.byteLength,
          signed: address.displacement.signed
        });

    region.write(
      this.#offset,
      region.values.binary("add", scaledIndex, displacement)
    );
    region.write(
      this.#segmentIndex,
      this.#selectSegmentIndex(
        region,
        region.values.const(segmentRegisterIndex(address.defaultSegment))
      )
    );
    if (address.base === undefined) {
      region.write(
        this.#addressKind,
        region.values.const(baseLessAddressKind)
      );
      return;
    }
    region.write(
      this.#baseRegisterIndex,
      region.values.const(reg32Index(address.base))
    );
    region.write(
      this.#addressKind,
      region.values.const(dynamicBaseAddressKind)
    );
  }

  #selectSegmentIndex(
    region: RegionBuilder,
    defaultSegmentIndex: ValueId
  ): ValueId {
    return region.values.select(
      region.read(this.#segmentOverride.present),
      region.read(this.#segmentOverride.registerIndex),
      defaultSegmentIndex
    );
  }

  #matchesAnyEncoding(
    region: RegionBuilder,
    value: ValueId,
    encodings: readonly number[]
  ): ValueId {
    const first = encodings[0]!;
    let matches = region.values.compare(
      32,
      "eq",
      value,
      region.values.const(first)
    );

    for (const encoding of encodings.slice(1)) {
      matches = region.values.binary(
        "or",
        matches,
        region.values.compare(
          32,
          "eq",
          value,
          region.values.const(encoding)
        )
      );
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
  const groups = [...encodingsBySegment]
    .sort((left, right) => left[1].length - right[1].length);
  const compared = groups[0]!;
  const fallback = groups[1]!;

  return {
    displacement,
    matchedSegment: compared[0],
    matchedEncodings: compared[1],
    fallbackSegment: fallback[0]
  };
}
