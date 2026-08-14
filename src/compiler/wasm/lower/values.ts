import { assert } from "#common/assert.js";
import type {
  IntegerRef,
  ValueExpression,
  ValueRef
} from "#compiler/function/values/expression.js";
import type { ZeroTestOperator } from "#compiler/function/values/integer/operators.js";
import type { ValueIdentity, ValueResolver } from "#compiler/function/values/resolver.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import { zeroExtendedRequiredBits } from "#compiler/wasm/function/values/integer/required-bits.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmValueTypeFor } from "#compiler/wasm/type-mapping.js";
import { lowerFloatOperation } from "./float.js";
import { LowBits } from "./integer/low-bits.js";
import {
  lowerIntegerOperation,
  normalizeInteger,
  type IntegerLowering,
  type IntegerView
} from "./integer/operations.js";

type LoweredValue = Readonly<{
  base: WasmValueId;
  unsigned?: WasmValueId;
  signed?: WasmValueId;
}>;

export class ValueLowerer {
  readonly #source: ValueResolver;
  readonly #lowered = new Map<ValueIdentity, LoweredValue>();
  readonly #integerLowering: IntegerLowering;

  constructor(
    source: ValueResolver,
    readonly wasm: WasmValuesBuilder
  ) {
    this.#source = source;
    const lower = (value: IntegerRef) => this.lower(value);
    const lowBits = new LowBits(source, wasm, lower);

    this.#integerLowering = {
      wasm,
      lowBits,
      lower,
      normalize: (value, view) => this.normalize(value, view)
    };
  }

  bind(value: ValueRef, wasmValue: WasmValueId): void {
    const { identity, expression } = this.#source.resolve(value);
    const wasmType = this.wasm.node(wasmValue).type;

    assert(!this.#lowered.has(identity), `source value ${identity} is already defined`);
    assert(
      wasmValueTypeFor(expression.kind, expression.width) === wasmType,
      `source value ${identity} and Wasm value ${wasmValue} have different representations`
    );
    this.#lowered.set(identity, this.#loweringFromBase(expression, wasmValue));
  }

  lower(value: ValueRef): WasmValueId {
    return this.#lowering(value).base;
  }

  normalize(value: IntegerRef, view: IntegerView): WasmValueId {
    const { identity, expression } = this.#source.resolve(value);
    const width = expression.width;
    const lowered = this.#loweringAt(identity, expression);

    if (width === 32 || width === 64) {
      return lowered.base;
    }
    const existing = lowered[view];

    if (existing !== undefined) {
      return existing;
    }
    const normalized = normalizeInteger(this.wasm, width, lowered.base, view);

    this.#lowered.set(identity, { ...lowered, [view]: normalized });
    return normalized;
  }

  condition(value: IntegerRef): WasmValueId {
    const expression = this.#source.resolve(value).expression;

    if (expression.op === "integer.zeroTest") {
      return expression.attr === "eqz"
        ? this.wasm.eqz(this.#zeroTestOperand(expression.a))
        : this.#nonzeroCondition(expression.a);
    }
    return this.normalize(value, "unsigned");
  }

  isUnreachable(value: ValueRef): boolean {
    return this.#source.resolve(value).expression.op === "integer.unreachable";
  }

  #lowering(value: ValueRef): LoweredValue {
    const { identity, expression } = this.#source.resolve(value);

    return this.#loweringAt(identity, expression);
  }

  #loweringAt(identity: ValueIdentity, expression: ValueExpression): LoweredValue {
    const existing = this.#lowered.get(identity);

    if (existing !== undefined) {
      return existing;
    }
    const lowered = this.#lowerExpression(expression);

    this.#lowered.set(identity, lowered);
    return lowered;
  }

  #lowerExpression(expression: ValueExpression): LoweredValue {
    switch (expression.op) {
      case "value.source": {
        const source = expression.attr;

        assert(source.kind === "parameter", "producer value has not been bound");
        const narrowInteger = expression.kind === "integer" && expression.width < 32;

        return this.#loweringFromBase(
          expression,
          this.wasm.parameter(
            source.index,
            wasmValueTypeFor(expression.kind, expression.width),
            narrowInteger ? zeroExtendedRequiredBits(32, expression.width) : undefined
          ),
          narrowInteger ? "unsigned" : undefined
        );
      }
      case "integer.constant":
      case "integer.unreachable":
      case "integer.binary":
      case "integer.compare":
      case "integer.truncate":
      case "integer.extend":
      case "integer.bitCount": {
        const { base, normalizedAs } = lowerIntegerOperation(expression, this.#integerLowering);

        return this.#loweringFromBase(expression, base, normalizedAs);
      }
      case "float.constant":
      case "float.binary":
      case "float.compare":
        return this.#loweringFromBase(expression, lowerFloatOperation(expression, this));
      case "integer.select":
      case "float.select":
        return this.#loweringFromBase(
          expression,
          this.wasm.select(
            this.condition(expression.a),
            this.lower(expression.b),
            this.lower(expression.c)
          )
        );
      case "integer.zeroTest":
        return this.#loweringFromBase(expression, this.#zeroTest(expression.attr, expression.a));
    }
  }

  #zeroTest(operator: ZeroTestOperator, value: IntegerRef): WasmValueId {
    const operand = this.#zeroTestOperand(value);

    if (
      operator === "nonzero" &&
      this.wasm.node(operand).type === "i32" &&
      this.wasm.requiredBits(operand).unsigned <= 1
    ) {
      return operand;
    }
    const zero = this.wasm.eqz(operand);

    return operator === "eqz" ? zero : this.wasm.eqz(zero);
  }

  #zeroTestOperand(value: IntegerRef): WasmValueId {
    const width = value.width;

    if (width >= 32) {
      return this.lower(value);
    }
    const lowered = this.#lowering(value);
    const existing = lowered.signed ?? lowered.unsigned;

    return existing ?? this.normalize(value, width === 1 ? "unsigned" : "signed");
  }

  #nonzeroCondition(value: IntegerRef): WasmValueId {
    const width = value.width;

    if (width === 64) {
      return this.wasm.eqz(this.wasm.eqz(this.lower(value)));
    }
    return width === 32 ? this.lower(value) : this.normalize(value, "unsigned");
  }

  #loweringFromBase(
    expression: ValueExpression,
    base: WasmValueId,
    normalizedAs?: IntegerView
  ): LoweredValue {
    const width = expression.width;

    if (expression.kind !== "integer" || width >= 32) {
      return { base };
    }
    const bits = this.wasm.requiredBits(base);
    const unreachable = expression.op === "integer.unreachable";
    let unsigned = unreachable || bits.unsigned <= width ? base : undefined;
    let signed = unreachable || bits.signed <= width ? base : undefined;

    if (normalizedAs === "unsigned") {
      unsigned = base;
    } else if (normalizedAs === "signed") {
      signed = base;
    }
    return {
      base,
      ...(unsigned === undefined ? {} : { unsigned }),
      ...(signed === undefined ? {} : { signed })
    };
  }
}
