import { assert } from "#common/assert.js";
import { integerConstantOf } from "#compiler/function/values/integer/fold-rules.js";
import { bitLength, effectiveShiftAmount } from "#compiler/function/values/integer/width.js";
import type { ValueRecord } from "#compiler/function/values/record.js";
import type { IntegerRef } from "#compiler/function/values/reference.js";
import type { FunctionValues, ValueIdentity } from "#compiler/function/values/scope.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmIntegerType } from "#compiler/wasm/type-lowering.js";
import type { WasmIntegerType } from "#wasm/types.js";

// Low-bit observations propagate through operations independently of the
// signed and unsigned representations cached by the owning value lowerer.
export class LowBits {
  readonly #values: FunctionValues;
  readonly #wasm: WasmValuesBuilder;
  readonly #lowerFully: (value: IntegerRef) => WasmValueId;
  readonly #cache: (Map<number, WasmValueId> | undefined)[];

  constructor(
    values: FunctionValues,
    wasm: WasmValuesBuilder,
    lowerFully: (value: IntegerRef) => WasmValueId
  ) {
    this.#values = values;
    this.#wasm = wasm;
    this.#lowerFully = lowerFully;
    this.#cache = new Array(values.identityCount());
  }

  lower(value: IntegerRef, observedBits: number): WasmValueId {
    const { identity, record } = this.#values.resolutionOf(value);
    const width = value.width;

    assert(
      Number.isInteger(observedBits) && observedBits > 0 && observedBits <= width,
      `cannot observe ${observedBits} low bits of a ${width}-bit value`
    );
    if (observedBits === width) {
      return this.#lowerFully(value);
    }
    const existing = this.#cache[identity]?.get(observedBits);

    if (existing !== undefined) {
      return existing;
    }
    const lowered = this.#lowerUncached(value, record, observedBits);

    this.#cacheResult(identity, observedBits, lowered);
    return lowered;
  }

  lowerAnd(a: IntegerRef, b: IntegerRef, observedBits: number): WasmValueId {
    const left = this.#constantOf(a);
    const right = this.#constantOf(b);

    if (left !== undefined && right === undefined) {
      return this.#lowerAndConstant(b, a, left, observedBits, false);
    }
    if (right !== undefined && left === undefined) {
      return this.#lowerAndConstant(a, b, right, observedBits, true);
    }
    return this.#wasm.binary("and", this.lower(a, observedBits), this.lower(b, observedBits));
  }

  lowerShiftCount(value: IntegerRef, type: WasmIntegerType): WasmValueId {
    const source = this.#shiftCountSource(value, type === "i32" ? 5 : 6);
    const count = this.#lowerFully(source);
    const countType = this.#wasm.node(count).type;

    if (countType === type) {
      return count;
    }
    return this.#wasm.convert(type === "i64" ? "extend_i32_u" : "wrap_i64", count);
  }

  #cacheResult(identity: ValueIdentity, count: number, lowered: WasmValueId): void {
    let values = this.#cache[identity];

    if (values === undefined) {
      values = new Map();
      this.#cache[identity] = values;
    }
    values.set(count, lowered);
  }

  #lowerUncached(value: IntegerRef, record: ValueRecord, count: number): WasmValueId {
    if (record.op !== "integer.binary") {
      return this.#lowerFully(value);
    }
    const { a, b } = record;

    switch (record.attr) {
      case "and":
        return this.lowerAnd(a, b, count);
      case "shr_u": {
        const width = a.width;
        const constant = this.#constantOf(b);

        if (constant === undefined) {
          return this.#lowerFully(value);
        }
        const amount = effectiveShiftAmount(width, constant);

        if (amount === 0) {
          return this.lower(a, count);
        }
        const required = count + amount;

        if (required > width) {
          return this.#lowerFully(value);
        }
        return this.#wasm.binary(
          "shr_u",
          this.lower(a, required),
          this.lowerShiftCount(b, wasmIntegerType(width))
        );
      }
      default:
        return this.#lowerFully(value);
    }
  }

  #lowerAndConstant(
    value: IntegerRef,
    mask: IntegerRef,
    constant: bigint,
    observedBits: number,
    maskOnRight: boolean
  ): WasmValueId {
    const observedMask = (1n << BigInt(observedBits)) - 1n;
    const relevantMask = constant & observedMask;

    if (relevantMask === observedMask) {
      return this.lower(value, observedBits);
    }
    const required = bitLength(relevantMask);
    const input = required === 0 ? this.#lowerFully(value) : this.lower(value, required);
    const possibleBits = (1n << BigInt(this.#wasm.requiredBits(input).unsigned)) - 1n;

    if ((constant & possibleBits) === possibleBits) {
      return input;
    }
    const maskValue = this.#lowerFully(mask);

    return maskOnRight
      ? this.#wasm.binary("and", input, maskValue)
      : this.#wasm.binary("and", maskValue, input);
  }

  #constantOf(value: IntegerRef): bigint | undefined {
    return integerConstantOf(this.#values.resolutionOf(value).record);
  }

  #shiftCountSource(value: IntegerRef, requiredBits: number): IntegerRef {
    let source = value;

    for (;;) {
      const record = this.#values.resolutionOf(source).record;

      if (record.op !== "integer.extend" && record.op !== "integer.truncate") {
        return source;
      }
      const inner = record.a;

      if (inner.width < requiredBits) {
        return source;
      }
      source = inner;
    }
  }
}
