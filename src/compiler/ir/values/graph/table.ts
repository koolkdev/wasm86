import { assert } from "#common/assert.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import { resolveValue, type ValueHandle } from "../handle.js";
import { boundValue } from "../integer/value.js";
import type { AnyInteger, Integer } from "../integer/types.js";
import type { AnyValue, ValueType, ValueTuple } from "../type.js";
import type { ValueResolutionContext, ValueScopeRequirement } from "../expression.js";
import type { ValueId } from "#compiler/ir/value.js";
import { ValueArena } from "./arena.js";
import type { ValueDefinition } from "./definition.js";
import { loopInputValue, nodeOutputValue, parameterValue } from "./leaves.js";
import type { ValueGraph, ValueNode } from "./node.js";

const tableState = Symbol("valueTableState");

type ValueTableState = Readonly<{
  [tableState]: true;
  arena: ValueArena;
  expressionResolutions: WeakMap<ValueHandle, ValueResolution>;
  valueScope: ValueScope;
}>;

type ValueScope = Readonly<{
  parent?: ValueScope;
}>;

type ValueIds<Values extends readonly ValueHandle[]> = {
  readonly [Index in keyof Values]: ValueId;
};

type ValueResolution = Readonly<{
  id: ValueId;
  requirements: readonly ValueScopeRequirement[];
}>;

function isValueList(value: ValueHandle | readonly ValueHandle[]): value is readonly ValueHandle[] {
  return Array.isArray(value);
}

export class ValueTable implements ValueGraph {
  readonly #arena: ValueArena;
  readonly #expressionResolutions: WeakMap<ValueHandle, ValueResolution>;
  readonly #valueScope: ValueScope;

  constructor(state?: ValueTableState) {
    this.#arena = state?.arena ?? new ValueArena();
    this.#expressionResolutions = state?.expressionResolutions ?? new WeakMap();
    this.#valueScope = state?.valueScope ?? {};
  }

  childScope(): ValueTable {
    return new ValueTable({
      [tableState]: true,
      arena: this.#arena.childScope(),
      expressionResolutions: this.#expressionResolutions,
      valueScope: { parent: this.#valueScope }
    });
  }

  // Forks retain the existing graph prefix while isolating later allocation
  // and expression resolution.
  fork(): ValueTable {
    return new ValueTable({
      [tableState]: true,
      arena: this.#arena.fork(),
      expressionResolutions: new WeakMap(),
      valueScope: { parent: this.#valueScope }
    });
  }

  integer<Width extends IntegerWidth>(width: Width, id: ValueId): Integer<Width> {
    const actual = this.bitWidth(id);

    assert(actual === width, `value ${id} must be ${width} bits, got ${actual}`);
    return boundValue(width, { origin: this, id });
  }

  handles<const Types extends readonly ValueType[]>(
    types: Types,
    ids: readonly ValueId[]
  ): ValueTuple<Types>;
  handles(types: readonly ValueType[], ids: readonly ValueId[]): readonly AnyValue[] {
    assert(
      types.length === ids.length,
      `${ids.length} values do not align with ${types.length} types`
    );
    return types.map((type, index): AnyValue => {
      const id = ids[index];

      assert(id !== undefined, `value ${index} is missing`);
      switch (type.kind) {
        case "integer":
          return integerForWidth(this, type.width, id);
      }
    });
  }

  use<Width extends IntegerWidth>(value: ValueHandle<Width>): ValueId;
  use<const Values extends readonly ValueHandle[]>(values: Values): ValueIds<Values>;
  use(valueOrValues: ValueHandle | readonly ValueHandle[]): ValueId | readonly ValueId[] {
    const values = isValueList(valueOrValues) ? valueOrValues : [valueOrValues];
    const resolved = this.#resolveValues(values);

    if (isValueList(valueOrValues)) {
      return resolved;
    }
    const value = resolved[0];

    assert(value !== undefined, "single value resolution produced no value");
    return value;
  }

  sameValue(a: ValueHandle, b: ValueHandle): boolean {
    if (a.width !== b.width) {
      return false;
    }
    const [left, right] = this.use([a, b]);

    return left === right;
  }

  node(id: ValueId): ValueNode {
    return this.#arena.node(id);
  }

  size(): number {
    return this.#arena.size();
  }

  children(id: ValueId): readonly ValueId[] {
    return this.#arena.children(id);
  }

  bitWidth(id: ValueId): IntegerWidth {
    return this.#arena.bitWidth(id);
  }

  isUnreachable(id: ValueId): boolean {
    return this.#arena.isUnreachable(id);
  }

  constant(id: ValueId): bigint | undefined {
    return this.#arena.constant(id);
  }

  constValue(id: ValueId): number | undefined {
    return this.#arena.constValue(id);
  }

  parameter(index: number, width: IntegerWidth): ValueId {
    return this.create(parameterValue, { index, width });
  }

  functionParameter(index: number, type: ValueType): ValueId {
    switch (type.kind) {
      case "integer":
        return this.parameter(index, type.width);
    }
  }

  addNodeOutput(width: IntegerWidth): ValueId {
    return this.create(nodeOutputValue, { width });
  }

  addLoopInput(width: IntegerWidth): ValueId {
    return this.create(loopInputValue, { width });
  }

  create<Args, Node extends ValueNode>(
    definition: ValueDefinition<Args, Node>,
    args: Args
  ): ValueId {
    return this.#arena.create(definition, args);
  }

  #resolveValues(values: readonly ValueHandle[]): readonly ValueId[] {
    const resolutions = new Map<ValueHandle, ValueResolution>();
    const resolve = (value: ValueHandle): ValueResolution => {
      const existing = resolutions.get(value) ?? this.#expressionResolutions.get(value);

      if (existing !== undefined) {
        this.#assertRequirements(existing.requirements);
        resolutions.set(value, existing);
        return existing;
      }

      const requirements: ValueScopeRequirement[] = [];
      const context: ValueResolutionContext = {
        value: (dependency) => {
          const dependencyResolution = resolve(dependency);

          for (const requirement of dependencyResolution.requirements) {
            addRequirement(requirements, requirement);
          }
          return dependencyResolution.id;
        },
        create: (definition, args) => this.create(definition, args),
        require: (requirement) => {
          this.#assertRequirement(requirement);
          addRequirement(requirements, requirement);
        },
        bitWidth: (id) => this.bitWidth(id)
      };
      const id = value[resolveValue](context);
      const actualWidth = this.bitWidth(id);

      assert(
        actualWidth === value.width,
        `${value.width}-bit expression produced a ${actualWidth}-bit value`
      );
      const resolution: ValueResolution = { id, requirements };

      resolutions.set(value, resolution);
      this.#expressionResolutions.set(value, resolution);
      return resolution;
    };

    return values.map((value) => resolve(value).id);
  }

  #assertRequirements(requirements: readonly ValueScopeRequirement[]): void {
    for (const requirement of requirements) {
      this.#assertRequirement(requirement);
    }
  }

  #assertRequirement(requirement: ValueScopeRequirement): void {
    assert(
      this.#canUseValue(requirement.origin, requirement.id),
      "value is not visible in the target value scope"
    );
  }

  #canUseValue(origin: ValueTable, id: ValueId): boolean {
    let scope: ValueScope | undefined = this.#valueScope;

    while (scope !== undefined && scope !== origin.#valueScope) {
      scope = scope.parent;
    }
    return scope !== undefined && this.#arena.sharesEntry(origin.#arena, id);
  }
}

function addRequirement(
  requirements: ValueScopeRequirement[],
  requirement: ValueScopeRequirement
): void {
  if (
    !requirements.some(
      (existing) => existing.origin === requirement.origin && existing.id === requirement.id
    )
  ) {
    requirements.push(requirement);
  }
}

function integerForWidth(table: ValueTable, width: IntegerWidth, id: ValueId): AnyInteger {
  switch (width) {
    case 1:
      return table.integer(1, id);
    case 8:
      return table.integer(8, id);
    case 16:
      return table.integer(16, id);
    case 32:
      return table.integer(32, id);
    case 64:
      return table.integer(64, id);
  }
}
