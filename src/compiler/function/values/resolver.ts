import { assert } from "#common/assert.js";
import {
  valueExpression,
  type ValueExpression,
  type ValueRef,
  type ValueSource
} from "./expression.js";
import { floatFromSource } from "./float/value.js";
import { integerFromSource } from "./integer/value.js";
import type { AnyValue, ValueForType, ValueTuple, ValueType } from "./type.js";

export type ValueIdentity = number;

export type ValueResolution = Readonly<{
  identity: ValueIdentity;
  expression: ValueExpression;
}>;

export class ValueResolver {
  readonly #resolvedRefs = new WeakMap<ValueRef, ValueResolution>();
  readonly #sourceValues = new WeakMap<ValueSource, ValueResolution>();
  readonly #parameters: (ValueRef | undefined)[] = [];
  readonly #interned = new Map<string, ValueResolution>();
  #nextIdentity: ValueIdentity = 0;

  parameters<const Types extends readonly ValueType[]>(types: Types): ValueTuple<Types>;
  parameters(types: readonly ValueType[]): readonly AnyValue[] {
    return types.map((type, index) => this.parameter(index, type));
  }

  parameter<Type extends ValueType>(index: number, type: Type): ValueForType<Type>;
  parameter(index: number, type: ValueType): ValueRef {
    const existing = this.#parameters[index];

    if (existing !== undefined) {
      assert(
        existing.kind === type.kind && existing.width === type.width,
        `parameter ${index} already has a different value type`
      );
      return existing;
    }
    const value = this.#createSourceValue(type, { kind: "parameter", index });

    this.#parameters[index] = value;
    return value;
  }

  producer<Type extends ValueType>(type: Type): ValueForType<Type>;
  producer(type: ValueType): ValueRef {
    return this.#createSourceValue(type, { kind: "producer" });
  }

  resolve(value: ValueRef): ValueResolution {
    const existing = this.#resolvedRefs.get(value);

    if (existing !== undefined) {
      return existing;
    }
    const expression = value[valueExpression]();

    assert(
      expression.kind === value.kind && expression.width === value.width,
      "value expression has a different value type"
    );
    switch (expression.op) {
      case "value.source": {
        const resolution = this.#sourceValues.get(expression.attr);

        assert(resolution !== undefined, "value source belongs to another resolver");
        this.#resolvedRefs.set(value, resolution);
        return resolution;
      }
      default: {
        const a = this.#operand(expression.a);
        const b = this.#operand(expression.b);
        const c = this.#operand(expression.c);
        const resolution = this.#intern(expression, a, b, c);

        this.#resolvedRefs.set(value, resolution);
        return resolution;
      }
    }
  }

  sameValue(a: ValueRef, b: ValueRef): boolean {
    return (
      a.kind === b.kind &&
      a.width === b.width &&
      this.resolve(a).identity === this.resolve(b).identity
    );
  }

  #createSourceValue(type: ValueType, source: ValueSource): ValueRef {
    const value = valueFromSource(type, source);
    const resolution = this.#mint(value[valueExpression]());

    this.#sourceValues.set(source, resolution);
    this.#resolvedRefs.set(value, resolution);
    return value;
  }

  #operand(value: ValueRef | undefined): ValueResolution | undefined {
    return value === undefined ? undefined : this.resolve(value);
  }

  #intern(
    expression: ValueExpression,
    a: ValueResolution | undefined,
    b: ValueResolution | undefined,
    c: ValueResolution | undefined
  ): ValueResolution {
    const key = expressionKey(expression, a, b, c);
    const existing = this.#interned.get(key);

    if (existing !== undefined) {
      return existing;
    }
    const resolution = this.#mint(expression);

    this.#interned.set(key, resolution);
    return resolution;
  }

  #mint(expression: ValueExpression): ValueResolution {
    const resolution = {
      identity: this.#nextIdentity,
      expression
    };

    this.#nextIdentity += 1;
    return resolution;
  }
}

function expressionKey(
  expression: ValueExpression,
  a: ValueResolution | undefined,
  b: ValueResolution | undefined,
  c: ValueResolution | undefined
): string {
  return `${expression.op}:${expression.kind}:${expression.width}:${String(expression.attr)}:${a?.identity ?? ""}:${b?.identity ?? ""}:${c?.identity ?? ""}`;
}

function valueFromSource<Type extends ValueType>(
  type: Type,
  source: ValueSource
): ValueForType<Type>;
function valueFromSource(type: ValueType, source: ValueSource): ValueRef {
  switch (type.kind) {
    case "integer":
      return integerFromSource(type.width, source);
    case "float":
      return floatFromSource(type.width, source);
  }
}
