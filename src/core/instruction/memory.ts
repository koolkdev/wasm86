import type { RegionBuilder } from "#ir/region-builder.js";
import type {
  MemoryAccess,
  MemoryAccessConstruction,
  MemoryAccessOperations,
  MemoryDataAccessIntent
} from "#memory/access.js";
import type {
  SemanticMemoryAccessOptions,
  SemanticMemoryOps,
  SemanticMemoryReadOptions,
  SemanticMemoryWriteOptions
} from "#core/semantics/builder.js";
import type {
  MemRef,
  OperandInput,
  Value,
  ValueInput
} from "#core/semantics/refs.js";
import type { SegmentRegister } from "#core/types.js";
import type { ScopedOperandResolver } from "./operand-resolver.js";

type InstructionMemoryOptions = Readonly<{
  faultAccess(access: MemoryAccess<MemoryDataAccessIntent>): void;
  recordWrite(): void;
}>;

// Adapts decoded x86 references to Memory's reusable linear-range capability.
// Raw resolution stays available; access() composes the instruction lifecycle's
// exact-scope failure policy without performing a transfer.
export class InstructionMemory implements SemanticMemoryOps {
  readonly #region: RegionBuilder;
  readonly #operands: ScopedOperandResolver;
  readonly #memory: MemoryAccessOperations;
  readonly #options: InstructionMemoryOptions;

  constructor(
    region: RegionBuilder,
    construction: MemoryAccessConstruction,
    operands: ScopedOperandResolver,
    options: InstructionMemoryOptions
  ) {
    this.#region = region;
    this.#operands = operands;
    this.#memory = construction.bind(region);
    this.#options = options;
  }

  reference(segment: SegmentRegister, offset: ValueInput): MemRef {
    return {
      segment: { kind: "static", reg: segment },
      offset
    };
  }

  operand(
    operand: OperandInput,
    addressOffset?: ValueInput
  ): MemRef {
    const reference = this.#operands.memoryReference(operand.index);

    return addressOffset === undefined
      ? reference
      : {
          segment: reference.segment,
          offset: this.#region.values.binary(
            "add",
            reference.offset,
            addressOffset
          )
        };
  }

  resolve<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent> {
    const { reference, byteLength, intent } = options;

    return this.#memory.resolve(
      { start: this.#operands.resolveAddress(reference), byteLength },
      intent
    );
  }

  access<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent> {
    const access = this.resolve(options);

    this.#options.faultAccess(access);
    return access;
  }

  read(access: MemoryAccess, options: SemanticMemoryReadOptions): Value {
    return this.#memory.read(
      access,
      options.byteOffset ?? this.#region.values.const(0),
      options.width,
      options.signed === true ? { signed: true } : {}
    );
  }

  write(
    access: MemoryAccess<"write">,
    options: SemanticMemoryWriteOptions
  ): void {
    this.#options.recordWrite();
    this.#memory.write(
      access,
      options.byteOffset ?? this.#region.values.const(0),
      options.value,
      options.width
    );
  }
}
