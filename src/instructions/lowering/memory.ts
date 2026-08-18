import { i32, type Integer, type I32Value } from "#compiler/function/values.js";
import type {
  BoundMemoryAccess,
  LinearRange,
  MemoryAccess,
  MemoryDataAccessIntent,
  ResolvedMemoryAccess
} from "#memory/types.js";
import type {
  AccessFault,
  AccessResolution,
  SemanticMemoryAccessOptions,
  SemanticMemoryOps
} from "#instructions/semantics/builder.js";
import type { MemRef, OperandRef } from "#instructions/semantics/refs.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { ScopedOperandResolver } from "./operand-resolver.js";

type InstructionMemoryOptions = Readonly<{
  raiseFault(fault: AccessFault): void;
  recordWrite(): void;
}>;

// Adapts segmented x86 references to Memory's linear access descriptions.
// Guarding stays here because Core owns CPU-exception control and restart state.
export class InstructionMemory implements SemanticMemoryOps {
  readonly #operands: ScopedOperandResolver;
  readonly #memory: BoundMemoryAccess;
  readonly #options: InstructionMemoryOptions;

  constructor(
    region: RegionBuilder,
    memory: MemoryAccess,
    operands: ScopedOperandResolver,
    options: InstructionMemoryOptions
  ) {
    this.#operands = operands;
    this.#memory = memory.forRegion(region);
    this.#options = options;
  }

  reference(segment: SegmentRegister, offset: I32Value): MemRef {
    return {
      segment: { kind: "static", reg: segment },
      offset
    };
  }

  operand(operand: OperandRef, addressOffset?: I32Value): MemRef {
    const reference = this.#operands.memoryReference(operand.index);

    return addressOffset === undefined
      ? reference
      : {
          segment: reference.segment,
          offset: reference.offset.add(addressOffset)
        };
  }

  resolve<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): AccessResolution<TIntent> {
    const { reference, byteLength, intent } = options;
    const resolution = this.#memory.resolve(this.#range(reference, byteLength), intent);

    return { access: resolution.access, fault: resolution.fault };
  }

  guard<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): ResolvedMemoryAccess<TIntent> {
    const resolution = this.resolve(options);

    this.#options.raiseFault(resolution.fault);
    return resolution.access;
  }

  read<const Width extends OperandWidth>(reference: MemRef, width: Width): Integer<Width> {
    const access = this.guard({
      reference,
      byteLength: i32(width / 8),
      intent: "read"
    });

    return this.load(access, width);
  }

  write<const Width extends OperandWidth>(reference: MemRef, value: Integer<Width>): void {
    const access = this.guard({
      reference,
      byteLength: i32(value.width / 8),
      intent: "write"
    });

    this.store(access, value);
  }

  load<const Width extends OperandWidth>(
    access: ResolvedMemoryAccess,
    width: Width,
    byteOffset?: I32Value
  ): Integer<Width> {
    return this.#memory.load(access, byteOffset ?? i32(0), width);
  }

  store<const Width extends OperandWidth>(
    access: ResolvedMemoryAccess<"write">,
    value: Integer<Width>,
    byteOffset?: I32Value
  ): void {
    this.#options.recordWrite();
    this.#memory.store(access, byteOffset ?? i32(0), value);
  }

  #range(reference: MemRef, byteLength: I32Value): LinearRange {
    return {
      start: this.#operands.resolveAddress(reference),
      byteLength
    };
  }
}
