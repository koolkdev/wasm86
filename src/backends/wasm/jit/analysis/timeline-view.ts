import type {
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type {
  StorageReadRef,
  TimelineExpression,
  TimelineStorage,
  TimelineView
} from "./timeline-types.js";

export class TimelineOpView implements TimelineView {
  readonly #storage: TimelineStorage;
  readonly opIndex: number;

  constructor(storage: TimelineStorage, opCount: number, opIndex: number) {
    if (!Number.isInteger(opIndex) || opIndex < 0 || opIndex >= opCount) {
      throw new Error(`missing JIT timeline op view for expression op ${opIndex}`);
    }

    this.#storage = storage;
    this.opIndex = opIndex;
  }

  value(value: IrValueExpr): JitValue {
    switch (value.kind) {
      case "const":
      case "var":
        return this.ref(value);
      case "nextEip":
        throw new Error("missing JIT timeline value");
      case "source":
      case "address":
      case "flags.condition":
      case "value.binary":
      case "value.unary":
      case "value.select":
        return this.expression(value);
    }
  }

  expression(value: TimelineExpression): JitValue {
    return timelineValue(
      this.#storage.expressionsByOp
        ?.get(this.opIndex)
        ?.get(timelineId(this.#storage.catalog.expressionId(value)))
    );
  }

  ref(ref: ValueRef): JitValue {
    switch (ref.kind) {
      case "const":
        return { kind: "const", type: ref.type, value: ref.value };
      case "nextEip":
        throw new Error("missing JIT timeline value");
      case "var":
        return timelineValue(this.#storage.refsByOp?.get(this.opIndex)?.get(ref.id));
    }
  }

  storageAddress(target: IrStorageExpr): JitValue {
    switch (target.kind) {
      case "mem":
        return this.value(target.address);
      case "operand":
        throw new Error("missing JIT timeline value");
      case "reg":
        throw new Error("missing JIT timeline value");
    }
  }

  storageRead(read: StorageReadRef): JitValue {
    return timelineValue(
      this.#storage.storageReadsByOp
        ?.get(this.opIndex)
        ?.get(timelineId(this.#storage.catalog.storageReadId(read)))
    );
  }

  hasValue(value: IrValueExpr): boolean {
    switch (value.kind) {
      case "const":
      case "var":
        return this.hasRef(value);
      case "nextEip":
        return false;
      case "source":
      case "address":
      case "flags.condition":
      case "value.binary":
      case "value.unary":
      case "value.select":
        return this.hasExpression(value);
    }
  }

  hasExpression(value: TimelineExpression): boolean {
    const id = this.#storage.catalog.expressionId(value);

    return id !== undefined && this.#storage.expressionsByOp?.get(this.opIndex)?.has(id) === true;
  }

  hasRef(ref: ValueRef): boolean {
    switch (ref.kind) {
      case "const":
        return true;
      case "nextEip":
        return false;
      case "var":
        return this.#storage.refsByOp?.get(this.opIndex)?.has(ref.id) === true;
    }
  }

  hasStorageAddress(target: IrStorageExpr): boolean {
    switch (target.kind) {
      case "mem":
        return this.hasValue(target.address);
      case "operand":
        return false;
      case "reg":
        return false;
    }
  }

  hasStorageRead(read: StorageReadRef): boolean {
    const id = this.#storage.catalog.storageReadId(read);

    return id !== undefined && this.#storage.storageReadsByOp?.get(this.opIndex)?.has(id) === true;
  }
}

function timelineId<T>(id: T | undefined): T {
  if (id === undefined) {
    throw new Error("missing JIT timeline id");
  }

  return id;
}

function timelineValue(value: JitValue | undefined): JitValue {
  if (value === undefined) {
    throw new Error("missing JIT timeline value");
  }

  return value;
}
