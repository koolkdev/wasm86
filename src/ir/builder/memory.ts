import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type { GetOptions } from "#core/semantics/builder.js";
import type {
  MemRef,
  MemoryAccess,
  MemoryAccessKind,
  OperandInput,
  Value,
  ValueInput
} from "#core/semantics/refs.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import {
  flatMemoryAccess,
  flatMemoryOperand
} from "#memory/flat.js";
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
    const linearAddress = this.#operands.resolveAddress(memory);
    const flat = flatMemoryAccess(
      this.#values,
      linearAddress,
      byteLength,
      intent
    );

    return {
      kind: "memoryAccess",
      resource: flat.resource,
      origin: flat.origin,
      linearAddress: flat.start,
      byteLength: flat.byteLength,
      invalid: flat.invalid,
      intent: flat.intent
    };
  }

  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options: GetOptions = {}
  ): Value {
    const source = flatMemoryOperand(
      this.#values,
      {
        resource: access.resource,
        origin: access.origin,
        start: access.linearAddress,
        byteLength: access.byteLength
      },
      byteOffset,
      width
    );
    const signed = options.signed === true && width !== 32;

    return this.#scopes.current.body.operation(
      resourceRead.create(signed ? { source, signed: true } : { source })
    );
  }

  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void {
    const destination = flatMemoryOperand(
      this.#values,
      {
        resource: access.resource,
        origin: access.origin,
        start: access.linearAddress,
        byteLength: access.byteLength
      },
      byteOffset,
      width
    );

    this.#scopes.current.recordMemoryWrite();
    this.#scopes.current.body.operation(
      resourceWrite.create({ destination, value })
    );
  }
}
