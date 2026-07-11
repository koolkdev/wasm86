import { assert } from "#common/assert.js";
import type { GetOptions } from "#x86/semantics/builder.js";
import type {
  MemRef,
  MemoryAccess,
  MemoryAccessKind,
  OperandInput,
  Value,
  ValueInput
} from "#x86/semantics/refs.js";
import type { OperandWidth, SegmentRegister } from "#x86/types.js";
import type { ValueTable } from "../value-table.js";
import type { ValueId } from "../values.js";
import type { OperandResolver } from "./operands.js";
import type { SemanticScopeStack } from "./scope.js";

export type MemoryManagerOptions = Readonly<{
  values: ValueTable;
  scopes: SemanticScopeStack;
  operands: OperandResolver;
}>;

export class MemoryManager {
  readonly #values: ValueTable;
  readonly #scopes: SemanticScopeStack;
  readonly #operands: OperandResolver;

  constructor(options: MemoryManagerOptions) {
    this.#values = options.values;
    this.#scopes = options.scopes;
    this.#operands = options.operands;
  }

  mem(segment: SegmentRegister, offset: ValueInput): MemRef {
    this.#values.node(offset);
    return {
      segment: { kind: "static", reg: segment },
      offset
    };
  }

  operandMem(operand: OperandInput, displacement?: ValueInput): MemRef {
    const memory = this.#operands.memoryReference(operand.index);

    if (displacement === undefined) {
      return memory;
    }
    this.#values.node(displacement);

    return {
      segment: memory.segment,
      offset: this.#values.binary("add", memory.offset, displacement)
    };
  }

  memoryResolve<TIntent extends MemoryAccessKind>(
    memory: MemRef,
    byteLength: ValueInput,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    const staticByteLength = this.#values.constValue(byteLength);

    assert(
      staticByteLength === undefined || staticByteLength > 0,
      `memory resolution byte length must be positive, got ${staticByteLength}`
    );
    const linearAddress = this.#operands.resolveAddress(memory);
    const invalid = this.#scopes.current.body.opValue({
      kind: "memory.resolve",
      address: linearAddress,
      byteLength
    });

    return {
      kind: "memoryAccess",
      linearAddress,
      byteLength,
      invalid,
      intent
    };
  }

  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options: GetOptions = {}
  ): Value {
    this.#assertSubrange(access.byteLength, byteOffset, width);
    const relative = this.#relativeAddress(access.linearAddress, byteOffset);

    return this.#readMemory(relative.address, width, options, relative.byteOffset);
  }

  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void {
    this.#assertSubrange(access.byteLength, byteOffset, width);
    const relative = this.#relativeAddress(access.linearAddress, byteOffset);

    this.#writeMemory(relative.address, value, width, relative.byteOffset);
  }

  #readMemory(
    address: ValueId,
    width: OperandWidth,
    options: GetOptions,
    byteOffset = 0
  ): Value {
    const signed = options.signed === true && width !== 32;

    return this.#scopes.current.body.opValue(
      signed
        ? { kind: "memory.read", address, byteOffset, width, signed: true }
        : { kind: "memory.read", address, byteOffset, width }
    );
  }

  #writeMemory(address: ValueId, value: ValueInput, width: OperandWidth, byteOffset = 0): void {
    this.#scopes.current.recordMemoryWrite();
    this.#scopes.current.body.op({ kind: "memory.write", address, byteOffset, value, width });
  }

  #assertSubrange(byteLength: ValueId, byteOffset: ValueId, width: OperandWidth): void {
    const staticByteLength = this.#values.constValue(byteLength);
    const staticByteOffset = this.#values.constValue(byteOffset);

    if (staticByteOffset === undefined) {
      return;
    }

    assert(staticByteOffset >= 0, `memory byte offset must be non-negative, got ${staticByteOffset}`);
    if (staticByteLength !== undefined) {
      assert(
        staticByteOffset + width / 8 <= staticByteLength,
        `${width}-bit memory access at byte offset ${staticByteOffset} exceeds ${staticByteLength}-byte resolution`
      );
    }
  }

  #relativeAddress(
    address: ValueId,
    byteOffset: ValueId
  ): Readonly<{ address: ValueId; byteOffset: number }> {
    const staticByteOffset = this.#values.constValue(byteOffset);

    return staticByteOffset === undefined
      ? { address: this.#values.binary("add", address, byteOffset), byteOffset: 0 }
      : { address, byteOffset: staticByteOffset };
  }
}
