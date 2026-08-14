import { assert } from "#common/assert.js";
import type { IntegerRef, ValueExpression } from "#compiler/function/values/expression.js";
import { effectiveShiftAmount } from "#compiler/function/values/integer/evaluate.js";
import { bitLength } from "#compiler/function/values/integer/width.js";
import type { ValueIdentity, ValueResolver } from "#compiler/function/values/resolver.js";
import type { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmIntegerType } from "#compiler/wasm/type-mapping.js";
import type { WasmIntegerType } from "#wasm/types.js";

export class LowBits {
  readonly #values: ValueResolver;
  readonly #wasm: WasmValuesBuilder;
  readonly #lowerFully: (value: IntegerRef) => WasmValueId;
  readonly #cache = new Map<ValueIdentity, Map<number, WasmValueId>>();

  constructor(
    values: ValueResolver,
    wasm: WasmValuesBuilder,
    lowerFully: (value: IntegerRef) => WasmValueId
  ) {
    this.#values = values;
    this.#wasm = wasm;
    this.#lowerFully = lowerFully;
  }

  lower(value: IntegerRef, observedBits: number): WasmValueId {
    const { identity, expression } = this.#values.resolve(value);
    const width = value.width;

    assert(
      Number.isInteger(observedBits) && observedBits > 0 && observedBits <= width,
      `cannot observe ${observedBits} low bits of a ${width}-bit value`
    );
    if (observedBits === width) {
      return this.#lowerFully(value);
    }
    const existing = this.#cache.get(identity)?.get(observedBits);

    if (existing !== undefined) {
      return existing;
    }
    const lowered = this.#lowerUncached(value, expression, observedBits);
    let cached = this.#cache.get(identity);

    if (cached === undefined) {
      cached = new Map();
      this.#cache.set(identity, cached);
    }
    cached.set(observedBits, lowered);
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

  #lowerUncached(value: IntegerRef, expression: ValueExpression, count: number): WasmValueId {
    if (expression.op !== "integer.binary") {
      return this.#lowerFully(value);
    }
    const { a, b } = expression;

    switch (expression.attr) {
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
    const expression = this.#values.resolve(value).expression;

    return expression.op === "integer.constant" ? expression.attr : undefined;
  }

  #shiftCountSource(value: IntegerRef, requiredBits: number): IntegerRef {
    let source = value;

    for (;;) {
      const expression = this.#values.resolve(source).expression;

      if (expression.op !== "integer.extend" && expression.op !== "integer.truncate") {
        return source;
      }
      const inner = expression.a;

      if (inner.width < requiredBits) {
        return source;
      }
      source = inner;
    }
  }
}
