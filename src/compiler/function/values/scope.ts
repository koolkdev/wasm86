import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { boundFloatValue, floatConstantBits } from "./float/value.js";
import { expressionKey, foldExpression, type ValueResolution } from "./expression.js";
import { valueRecord, type IntegerRef, type ValueKind, type ValueRef } from "./reference.js";
import {
  boundValue,
  integerConstant,
  integerUnreachable,
  integerZeroTest
} from "./integer/value.js";
import type { AnyValue, ValueForType, ValueType, ValueTuple } from "./type.js";
import type { ValueRecord, ValueScopeRequirement, ValueSlot } from "./record.js";
import { integerConstantOf } from "./integer/fold-rules.js";

const scopeState = Symbol("valueScopeState");

// Dense per namespace. Identities answer equality only: they are never ordered,
// compared by magnitude, or read across namespaces.
export type ValueIdentity = number;

// Fork history, walked by pointer equality. A fork sees exactly the tags on its
// own chain, which is the snapshot the source took when it split.
type EpochTag = Readonly<{ parent?: EpochTag }>;
type EpochCell = { current: EpochTag };

type IdentityScope = Readonly<{
  // Derived expressions are reusable only from this lexical scope downward.
  expressions: Map<string, ValueIdentity>;
  parent?: IdentityScope;
}>;

type DeclaredSlot = Readonly<{ slot: ValueSlot; epoch: EpochTag }>;

// The root scope, its descendants, and its scratch forks share one namespace.
// It owns their identities and scope-independent leaves; each lexical scope
// keeps its own derived-expression table.
type ValueNamespace = {
  nextIdentity: ValueIdentity;
  // An identity answers with the record its first member carried, so a fold
  // and its literal equivalent read as one value.
  readonly identities: ValueResolution[];
  readonly slots: WeakMap<ValueSlot, ValueIdentity>;
  // Scope-independent leaves and function parameters are canonical across every
  // lexical scope and scratch fork in the namespace.
  readonly leaves: Map<string, ValueIdentity>;
  readonly epochTags: EpochTag[];
  readonly declared: DeclaredSlot[];
};

type ValueScopeState = Readonly<{
  [scopeState]: true;
  namespace: ValueNamespace;
  resolutions: WeakMap<ValueRef, ValueResolution>;
  scope: IdentityScope;
  epoch: EpochCell;
}>;

export class ValueScope {
  readonly #namespace: ValueNamespace;
  readonly #resolutions: WeakMap<ValueRef, ValueResolution>;
  readonly #scope: IdentityScope;
  readonly #epoch: EpochCell;

  constructor(state?: ValueScopeState) {
    this.#namespace = state?.namespace ?? {
      nextIdentity: 0,
      identities: [],
      slots: new WeakMap(),
      leaves: new Map(),
      epochTags: [],
      declared: []
    };
    this.#resolutions = state?.resolutions ?? new WeakMap();
    this.#scope = state?.scope ?? { expressions: new Map() };
    this.#epoch = state?.epoch ?? { current: {} };
  }

  childScope(): ValueScope {
    return new ValueScope({
      [scopeState]: true,
      namespace: this.#namespace,
      resolutions: this.#resolutions,
      scope: { expressions: new Map(), parent: this.#scope },
      epoch: this.#epoch
    });
  }

  // A scratch run re-resolves every reference it touches, so it shares the
  // namespace's identities but none of its resolutions; the epoch split is the
  // snapshot that hides each side's later mints from the other.
  fork(): ValueScope {
    const parent = this.#epoch.current;

    this.#epoch.current = { parent };
    return new ValueScope({
      [scopeState]: true,
      namespace: this.#namespace,
      resolutions: new WeakMap(),
      scope: { expressions: new Map(), parent: this.#scope },
      epoch: { current: { parent } }
    });
  }

  parameters<const Types extends readonly ValueType[]>(types: Types): ValueTuple<Types>;
  parameters(types: readonly ValueType[]): readonly AnyValue[] {
    return types.map((type, index) => this.parameter(index, type));
  }

  parameter<Type extends ValueType>(index: number, type: Type): ValueForType<Type>;
  parameter(index: number, type: ValueType): ValueRef {
    assert(Number.isInteger(index) && index >= 0, `invalid function parameter index: ${index}`);
    return this.#mint({ source: "parameter", type, index });
  }

  producer<Type extends ValueType>(type: Type): ValueForType<Type>;
  producer(type: ValueType): ValueRef {
    return this.#mint({ source: "producer", type, index: 0 });
  }

  loopInput<Type extends ValueType>(type: Type): ValueForType<Type>;
  loopInput(type: ValueType): ValueRef {
    return this.#mint({ source: "loopInput", type, index: 0 });
  }

  // The region that retains a routed node owns its output's value scope; a
  // node this scope minted keeps the reference it was minted with.
  rebind<Value extends ValueRef>(value: Value): Value;
  rebind(value: ValueRef): ValueRef {
    const requirement = value[valueRecord]().bound;

    assert(requirement !== undefined, "only slot values can be rebound");
    return requirement.origin === this ? value : slotValue(this, requirement.slot);
  }

  resolve(value: ValueRef): void {
    this.#resolve(value);
  }

  resolveAll(values: readonly ValueRef[]): void {
    for (const value of values) {
      this.#resolve(value);
    }
  }

  sameValue(a: ValueRef, b: ValueRef): boolean {
    if (a.kind !== b.kind || a.width !== b.width) {
      return false;
    }
    return this.#resolve(a).identity === this.#resolve(b).identity;
  }

  constValue(value: ValueRef): number | undefined {
    if (value.width === 64) {
      return undefined;
    }
    const constant = integerConstantOf(this.#resolve(value).record);

    return constant === undefined ? undefined : Number(BigInt.asIntN(32, constant));
  }

  canUseValue(origin: ValueScope, value: ValueRef): boolean {
    const slot = value[valueRecord]().bound?.slot;

    assert(slot !== undefined, "value scope checks apply to slot values");
    return this.#canUseSlot(origin, slot);
  }

  // The record a value stands for after folding: a fold's target, never the
  // folded expression. Every fact read goes through it.
  factOf(value: ValueRef): ValueRecord {
    return (this.#resolutions.get(value) ?? this.#resolve(value)).record;
  }

  constantOf(value: IntegerRef): bigint | undefined {
    return integerConstantOf(this.factOf(value));
  }

  // Lowering never mints identity: every reference the walk demands was
  // resolved at a builder identity moment, so this is one memo read for both
  // the identity it keys on and the record it selects from.
  resolutionOf(value: ValueRef): ValueResolution {
    const resolution = this.#resolutions.get(value);

    if (resolution === undefined) {
      assert(false, "lowering demanded a value that no builder moment resolved");
    }
    return resolution;
  }

  identityCount(): number {
    return this.#namespace.nextIdentity;
  }

  // Validation reads what the builder already resolved; it never resolves, so
  // it cannot fail a scope check the builder itself passed.
  recordOf(value: ValueRef): ValueRecord {
    return this.#resolutions.get(value)?.record ?? value[valueRecord]();
  }

  // Validation-only census. Forked scratch runs mint into the same namespace and
  // are hidden here by the same epoch snapshot that hides them from uses.
  declaredSlots(): readonly ValueSlot[] {
    return this.#namespace.declared
      .filter((entry) => this.#sees(entry.epoch))
      .map((entry) => entry.slot);
  }

  #mint(slot: ValueSlot): ValueRef {
    const value = slotValue(this, slot);
    const record = value[valueRecord]();
    // Parameters take one identity per index, the way the function boundary
    // declares them; producer and loop-input slots are occurrences.
    const resolution =
      slot.source === "parameter"
        ? this.#internLeaf(
            `p:${valueKeyPrefix(slot.type.kind)}${slot.type.width}:${slot.index}`,
            record
          )
        : this.#mintIdentity(record);

    this.#namespace.slots.set(slot, resolution.identity);
    if (buildDefinition.validation) {
      this.#namespace.declared.push({ slot, epoch: this.#epoch.current });
    }
    // Minting is the slot's identity moment: the node carrying this reference is
    // demanded by the walk, which never resolves.
    this.#resolutions.set(value, resolution);
    return value;
  }

  #resolve(value: ValueRef): ValueResolution {
    if (buildDefinition.validation) {
      this.#assertVisible(value, new Set());
    }
    return this.#resolveUnchecked(value);
  }

  #resolveUnchecked(value: ValueRef): ValueResolution {
    const existing = this.#resolutions.get(value);

    if (existing !== undefined) {
      return existing;
    }
    const resolution = this.#resolveRecord(value);

    assert(
      resolution.record.width === value.width,
      "value expression produced a different value type"
    );
    this.#resolutions.set(value, resolution);
    return resolution;
  }

  #resolveRecord(value: ValueRef): ValueResolution {
    const record = value[valueRecord]();

    switch (record.op) {
      // A constant is identified by its stored payload, so bit-distinct values
      // such as float +0 and -0 remain different values.
      case "integer.constant":
        return this.#internLeaf(`c:${record.width}:${record.attr}`, record);
      case "float.constant":
        return this.#internLeaf(`c:f:${record.width}:${record.attr}`, record);
      case "integer.unreachable":
        return this.#internLeaf(`u:${record.width}`, record);
      case "integer.bound":
      case "float.bound": {
        const requirement = record.bound;

        return this.#resolutionAt(this.#slotIdentity(requirement.slot));
      }
      default:
        return this.#resolveOperation(record);
    }
  }

  #resolveOperation(record: ValueRecord): ValueResolution {
    const a = this.#operand(record.a);
    const b = this.#operand(record.b);
    const c = this.#operand(record.c);
    const outcome = foldExpression(record, a, b, c);

    switch (outcome?.kind) {
      case "constant": {
        assert(record.kind === "integer", "integer fold produced a non-integer constant");
        const key = `c:${record.width}:${outcome.value}`;
        const existing = this.#namespace.leaves.get(key);

        if (existing !== undefined) {
          return this.#resolutionAt(existing);
        }
        const folded = integerConstant(record.width, outcome.value)[valueRecord]();

        return this.#mintLeaf(key, folded);
      }
      case "constantBits": {
        const key = `c:f:${record.width}:${outcome.bits}`;
        const existing = this.#namespace.leaves.get(key);

        if (existing !== undefined) {
          return this.#resolutionAt(existing);
        }
        const folded = floatConstantRecord(record, outcome.bits);

        return this.#mintLeaf(key, folded);
      }
      case "unreachable": {
        assert(record.kind === "integer", "integer fold produced non-integer unreachable flow");
        const key = `u:${record.width}`;
        const existing = this.#namespace.leaves.get(key);

        if (existing !== undefined) {
          return this.#resolutionAt(existing);
        }
        const folded = integerUnreachable(record.width)[valueRecord]();

        return this.#mintLeaf(key, folded);
      }
      case "operand": {
        const operand =
          outcome.which === "a" ? record.a : outcome.which === "b" ? record.b : record.c;

        assert(operand !== undefined, "operation record is missing a folded operand");
        return this.#resolveUnchecked(operand);
      }
      case "zeroTest": {
        const operand = outcome.operand === "a" ? record.a : record.b;

        assert(operand?.kind === "integer", "zero-test fold requires an integer operand");
        // The rewritten test is nobody else's reference, so it resolves without
        // a memo entry of its own.
        return this.#resolveRecord(integerZeroTest(outcome.operator, operand));
      }
      default:
        return this.#internExpression(expressionKey(record, a, b, c), record);
    }
  }

  #operand(value: ValueRef | undefined): ValueResolution | undefined {
    if (value === undefined) {
      return undefined;
    }
    return this.#resolveUnchecked(value);
  }

  #internLeaf(key: string, record: ValueRecord): ValueResolution {
    const existing = this.#namespace.leaves.get(key);

    return existing === undefined ? this.#mintLeaf(key, record) : this.#resolutionAt(existing);
  }

  #mintLeaf(key: string, record: ValueRecord): ValueResolution {
    const resolution = this.#mintIdentity(record);

    this.#namespace.leaves.set(key, resolution.identity);
    return resolution;
  }

  #internExpression(key: string, record: ValueRecord): ValueResolution {
    for (
      let scope: IdentityScope | undefined = this.#scope;
      scope !== undefined;
      scope = scope.parent
    ) {
      const existing = scope.expressions.get(key);

      if (existing !== undefined) {
        return this.#resolutionAt(existing);
      }
    }
    const resolution = this.#mintIdentity(record);

    this.#scope.expressions.set(key, resolution.identity);
    return resolution;
  }

  #mintIdentity(record: ValueRecord): ValueResolution {
    const identity = this.#namespace.nextIdentity;
    const resolution = { identity, record };

    this.#namespace.nextIdentity = identity + 1;
    this.#namespace.identities[identity] = resolution;
    if (buildDefinition.validation) {
      this.#namespace.epochTags[identity] = this.#epoch.current;
    }
    return resolution;
  }

  #resolutionAt(identity: ValueIdentity): ValueResolution {
    const resolution = this.#namespace.identities[identity];

    assert(resolution !== undefined, `identity ${identity} has no resolution`);
    return resolution;
  }

  #slotIdentity(slot: ValueSlot): ValueIdentity {
    const identity = this.#namespace.slots.get(slot);

    assert(identity !== undefined, "slot value was minted in another value namespace");
    return identity;
  }

  #canUseSlot(origin: ValueScope, slot: ValueSlot): boolean {
    let scope: IdentityScope | undefined = this.#scope;

    while (scope !== undefined && scope !== origin.#scope) {
      scope = scope.parent;
    }
    if (scope === undefined) {
      return false;
    }
    return this.#sees(this.#namespace.epochTags[this.#slotIdentity(slot)]);
  }

  #sees(tag: EpochTag | undefined): boolean {
    for (
      let current: EpochTag | undefined = this.#epoch.current;
      current !== undefined;
      current = current.parent
    ) {
      if (current === tag) {
        return true;
      }
    }
    return false;
  }

  #assertVisible(value: ValueRef, seen: Set<ValueRef>): void {
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    const record = value[valueRecord]();

    // Visibility belongs to the authored expression. Folding must not let a
    // discarded branch-local dependency escape its scope.
    if (record.bound !== undefined) {
      this.#assertRequirement(record.bound);
    }
    if (record.a !== undefined) {
      this.#assertVisible(record.a, seen);
    }
    if (record.b !== undefined) {
      this.#assertVisible(record.b, seen);
    }
    if (record.c !== undefined) {
      this.#assertVisible(record.c, seen);
    }
  }

  #assertRequirement(requirement: ValueScopeRequirement): void {
    assert(
      this.#canUseSlot(requirement.origin, requirement.slot),
      "value is not visible in the target value scope"
    );
  }
}

// A built function exposes established values, never the scope that minted them.
export type FunctionValues = Readonly<
  Pick<ValueScope, "identityCount" | "resolutionOf" | "recordOf" | "declaredSlots">
>;

function slotValue(scope: ValueScope, slot: ValueSlot): ValueRef {
  const requirement = { origin: scope, slot };

  switch (slot.type.kind) {
    case "integer":
      return boundValue(slot.type.width, requirement);
    case "float":
      return boundFloatValue(slot.type.width, requirement);
  }
}

function valueKeyPrefix(kind: ValueKind): string {
  switch (kind) {
    case "integer":
      return "";
    case "float":
      return "f:";
  }
}

function floatConstantRecord(record: ValueRecord, bits: number | bigint): ValueRecord {
  assert(record.kind === "float", "float fold produced a non-float constant");
  if (record.width === 32) {
    assert(typeof bits === "number", "f32 constant bits must be a number");
    return floatConstantBits(32, bits)[valueRecord]();
  }
  assert(typeof bits === "bigint", "f64 constant bits must be a bigint");
  return floatConstantBits(64, bits)[valueRecord]();
}
