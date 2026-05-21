import type {
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { OperandWidth } from "#x86/isa/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import type {
  StorageReadRef,
  TimelineExpression,
  TimelineExpressionId,
  TimelineIdCatalog,
  TimelineStorageId,
  TimelineStorageReadId
} from "./timeline-types.js";

export class TimelineRegistry implements TimelineIdCatalog {
  #nextExpressionId = 0;
  #nextStorageId = 0;
  #nextStorageReadId = 0;
  readonly #expressionIds = new Map<TimelineExpression, TimelineExpressionId>();
  readonly #regStorageIds = new Map<string, TimelineStorageId>();
  readonly #operandStorageIds = new Map<number, TimelineStorageId>();
  readonly #memStorageIds = new Map<IrValueExpr, TimelineStorageId>();
  readonly #storageReadIds = new Map<
    TimelineStorageId,
    Map<OperandWidth, Map<boolean, TimelineStorageReadId>>
  >();

  expressionId(value: TimelineExpression): TimelineExpressionId | undefined {
    return this.#expressionIds.get(value);
  }

  storageId(storage: IrStorageExpr): TimelineStorageId | undefined {
    switch (storage.kind) {
      case "reg":
        return this.#regStorageIds.get(regStorageKey(storage));
      case "operand":
        return this.#operandStorageIds.get(storage.index);
      case "mem":
        return this.#memStorageIds.get(storage.address);
    }
  }

  storageReadId(read: StorageReadRef): TimelineStorageReadId | undefined {
    const storageId = this.storageId(read.source);

    return storageId === undefined
      ? undefined
      : this.#storageReadIds
          .get(storageId)
          ?.get(read.accessWidth)
          ?.get(read.signed === true);
  }

  registerExpression(value: TimelineExpression): TimelineExpressionId {
    const existing = this.#expressionIds.get(value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#nextExpressionId as TimelineExpressionId;

    this.#nextExpressionId += 1;
    this.#expressionIds.set(value, id);
    return id;
  }

  registerStorage(storage: IrStorageExpr): TimelineStorageId {
    switch (storage.kind) {
      case "reg":
        return this.#registerStorageId(this.#regStorageIds, regStorageKey(storage));
      case "operand":
        return this.#registerStorageId(this.#operandStorageIds, storage.index);
      case "mem":
        return this.#registerStorageId(this.#memStorageIds, storage.address);
    }
  }

  registerStorageRead(read: StorageReadRef): TimelineStorageReadId {
    const storageId = this.registerStorage(read.source);
    let byWidth = this.#storageReadIds.get(storageId);

    if (byWidth === undefined) {
      byWidth = new Map();
      this.#storageReadIds.set(storageId, byWidth);
    }

    let bySigned = byWidth.get(read.accessWidth);

    if (bySigned === undefined) {
      bySigned = new Map();
      byWidth.set(read.accessWidth, bySigned);
    }

    const signed = read.signed === true;
    const existing = bySigned.get(signed);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#nextStorageReadId as TimelineStorageReadId;

    this.#nextStorageReadId += 1;
    bySigned.set(signed, id);
    return id;
  }

  #registerStorageId<TLookup>(
    ids: Map<TLookup, TimelineStorageId>,
    lookup: TLookup
  ): TimelineStorageId {
    const existing = ids.get(lookup);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#nextStorageId as TimelineStorageId;

    this.#nextStorageId += 1;
    ids.set(lookup, id);
    return id;
  }
}

function regStorageKey(storage: Extract<IrStorageExpr, { kind: "reg" }>): string {
  return registerAlias(storage.reg).name;
}
