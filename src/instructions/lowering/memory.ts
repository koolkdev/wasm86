import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type {
  LinearRange,
  MemoryAccess,
  MemoryAccessConstruction,
  MemoryAccessOperations,
  MemoryDataAccessIntent
} from "#memory/access.js";
import type {
  AccessFault,
  AccessResolution,
  SemanticMemoryAccessOptions,
  SemanticMemoryLoadOptions,
  SemanticMemoryOps,
  SemanticMemoryReadOptions,
  SemanticMemoryStoreOptions,
  SemanticMemoryWriteOptions
} from "#instructions/semantics/builder.js";
import type {
  MemRef,
  OperandInput,
  Value,
  ValueInput
} from "#instructions/semantics/refs.js";
import type { SegmentRegister } from "#core/types.js";
import type { ScopedOperandResolver } from "./operand-resolver.js";

type InstructionMemoryOptions = Readonly<{
  raiseFault(fault: AccessFault): void;
  recordWrite(): void;
}>;

// Adapts segmented x86 references to Memory's linear access descriptions.
// Guarding stays here because Core owns CPU-exception control and restart state.
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
  ): AccessResolution<TIntent> {
    const { reference, byteLength, intent } = options;
    const resolution = this.#memory.resolve(
      this.#range(reference, byteLength),
      intent
    );

    return { access: resolution.access, fault: resolution.fault };
  }

  guard<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent> {
    const resolution = this.resolve(options);

    this.#options.raiseFault(resolution.fault);
    return resolution.access;
  }

  read(
    reference: MemRef,
    options: SemanticMemoryReadOptions
  ): Value {
    const access = this.guard({
      reference,
      byteLength: this.#region.values.const(options.width / 8),
      intent: "read"
    });

    return this.load(access, options);
  }

  write(
    reference: MemRef,
    options: SemanticMemoryWriteOptions
  ): void {
    const access = this.guard({
      reference,
      byteLength: this.#region.values.const(options.width / 8),
      intent: "write"
    });

    this.store(access, { width: options.width, value: options.value });
  }

  load(
    access: MemoryAccess,
    options: SemanticMemoryLoadOptions
  ): Value {
    const { signed = false } = options;

    return this.#memory.load(
      access,
      options.byteOffset ?? this.#region.values.const(0),
      options.width,
      { signed }
    );
  }

  store(
    access: MemoryAccess<"write">,
    options: SemanticMemoryStoreOptions
  ): void {
    this.#options.recordWrite();
    this.#memory.store(
      access,
      options.byteOffset ?? this.#region.values.const(0),
      options.value,
      options.width
    );
  }

  #range(reference: MemRef, byteLength: ValueInput): LinearRange {
    return {
      start: this.#operands.resolveAddress(reference),
      byteLength
    };
  }
}
