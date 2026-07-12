import { assert } from "#common/assert.js";
import {
  get2,
  get3,
  get4,
  put2,
  put3,
  put4,
  type Map2,
  type Map3,
  type Map4
} from "#common/nested-map.js";
import {
  signedComparePredicates,
  type BinaryOperator,
  type CompareOperator,
  type UnaryOperator
} from "./operators.js";
import { i32 } from "#x86/numeric.js";
import type { OperandWidth } from "#x86/types.js";
import type { ExternalValueId } from "./operands.js";
import {
  foldBinary,
  foldCompare,
  foldExtend,
  foldTruncate,
  foldSelect,
  foldUnary,
  type ValueFoldContext
} from "./value-folding.js";
import {
  fitsUnsigned,
  signExtended,
  unboundedWidthBounds,
  valueId,
  type BinaryValueNode,
  type ExtendValueNode,
  type SelectValueNode,
  type UnaryValueNode,
  type ValueId,
  type ValueNode,
  type Values,
  type ValueType,
  type WidthBounds
} from "./values.js";

function clampedBounds(unsignedBits: number, signedBits: number): WidthBounds {
  return {
    unsignedBits,
    // Fitting unsigned in w implies sign extension from w + 1.
    signedBits: Math.min(signedBits, unsignedBits + 1, 32)
  };
}

export class ValueTable implements Values {
  readonly #nodes: ValueNode[] = [];
  // Derived on first query, memoized per node.
  readonly #widthBounds: (WidthBounds | undefined)[] = [];
  readonly #constIds = new Map<number, ValueId>();
  readonly #const64Ids = new Map<bigint, ValueId>();
  readonly #unreachableIds = new Map<ValueType, ValueId>();
  readonly #externalIds = new Map<ExternalValueId, ValueId>();
  readonly #binaryIds: Map4<ValueType, BinaryOperator, ValueId, ValueId, ValueId> = new Map();
  readonly #unaryIds: Map2<UnaryOperator, ValueId, ValueId> = new Map();
  readonly #compareIds: Map4<ValueType, CompareOperator, ValueId, ValueId, ValueId> = new Map();
  readonly #selectIds: Map3<ValueId, ValueId, ValueId, ValueId> = new Map();
  readonly #truncateIds: Map3<ValueType, OperandWidth, ValueId, ValueId> = new Map();
  readonly #extendIds: Map4<ValueType, boolean, OperandWidth, ValueId, ValueId> = new Map();

  node(id: ValueId): ValueNode {
    const found = this.#nodes[id];

    assert(found !== undefined, `unknown value id ${id}`);
    return found;
  }

  // The node's compile-time constant, when it is one; i32-canonical.
  constValue(id: ValueId): number | undefined {
    const found = this.node(id);

    return found.kind === "const" ? found.value : undefined;
  }

  size(): number {
    return this.#nodes.length;
  }

  valueType(id: ValueId): ValueType {
    return ValueTable.#valueTypeOf(this.node(id));
  }

  widthBounds(id: ValueId): WidthBounds {
    return this.#widthBoundsOf(id);
  }

  const(value: number): ValueId {
    return this.#internConst(value);
  }

  const64(value: bigint): ValueId {
    return this.#internConst64(value);
  }

  unreachable(type: ValueType = "i32"): ValueId {
    return this.#internUnreachable(type);
  }

  external(external: ExternalValueId): ValueId {
    return this.#internExternal(external);
  }

  addActionOutput(bounds?: WidthBounds): ValueId {
    // Each action produces a distinct value; outputs are never deduped.
    const id = this.#add({ kind: "actionOutput" }, []);

    this.#widthBounds[id] = bounds ?? unboundedWidthBounds;
    return id;
  }

  addLoopInput(bounds?: WidthBounds): ValueId {
    const id = this.#add({ kind: "loopInput" }, []);

    this.#widthBounds[id] = bounds ?? unboundedWidthBounds;
    return id;
  }

  binary(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId {
    this.#assertKnownChildren([a, b]);
    this.#assertValueType(a, "i32");
    this.#assertValueType(b, "i32");

    return foldBinary(this.#foldContext(), operator, a, b) ??
      this.#internBinary("i32", operator, a, b);
  }

  binary64(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId {
    this.#assertKnownChildren([a, b]);
    this.#assertValueType(a, "i64");
    this.#assertValueType(b, "i64");

    return this.#internBinary("i64", operator, a, b);
  }

  unary(operator: UnaryOperator, value: ValueId): ValueId {
    this.#assertKnownChildren([value]);
    this.#assertValueType(value, "i32");

    return foldUnary(this.#foldContext(), operator, value) ?? this.#internUnary(operator, value);
  }

  // Compares in the width's domain, lowering by predicate class: signed
  // predicates sign-extend operands, the rest mask them; 32 adjusts nothing.
  compare(width: OperandWidth, operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    const signed = signedComparePredicates.has(operator);

    return this.#compare(
      operator,
      this.widthAdjusted(width, a, signed),
      this.widthAdjusted(width, b, signed)
    );
  }

  #compare(operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    this.#assertKnownChildren([a, b]);
    this.#assertValueType(a, "i32");
    this.#assertValueType(b, "i32");

    return foldCompare(this.#foldContext(), operator, a, b) ??
      this.#internCompare("i32", operator, a, b);
  }

  compare64(operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    this.#assertKnownChildren([a, b]);
    this.#assertValueType(a, "i64");
    this.#assertValueType(b, "i64");

    return foldCompare(this.#foldContext(), operator, a, b) ??
      this.#internCompare("i64", operator, a, b);
  }

  select(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
    this.#assertKnownChildren([condition, whenTrue, whenFalse]);
    this.#assertValueType(condition, "i32");
    this.#assertValueType(whenTrue, "i32");
    this.#assertValueType(whenFalse, "i32");

    return foldSelect(this.#foldContext(), condition, whenTrue, whenFalse) ??
      this.#internSelect(condition, whenTrue, whenFalse);
  }

  truncate(width: OperandWidth, value: ValueId): ValueId {
    this.#assertKnownChildren([value]);
    this.#assertValueType(value, "i32");

    return foldTruncate(this.#foldContext(), width, value) ?? this.#internTruncate("i32", width, value);
  }

  truncate64(width: OperandWidth, value: ValueId): ValueId {
    this.#assertKnownChildren([value]);
    this.#assertValueType(value, "i64");

    const node = this.node(value);

    return node.kind === "extend" && node.type === "i64" && node.width === width
      ? this.truncate(width, node.value)
      : this.#internTruncate("i64", width, value);
  }

  extend(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
    this.#assertKnownChildren([value]);
    this.#assertValueType(value, "i32");

    const fold = signed ? foldExtend : foldTruncate;

    return fold(this.#foldContext(), width, value) ?? this.#internExtend("i32", signed, width, value);
  }

  // The value seen through a width-limited access: sign-extended when
  // signed, masked otherwise.
  widthAdjusted(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
    return signed ? this.extend(width, value, true) : this.truncate(width, value);
  }

  extend64(width: OperandWidth, value: ValueId, signed: boolean): ValueId {
    this.#assertKnownChildren([value]);
    this.#assertValueType(value, "i32");

    return this.#internExtend("i64", signed, width, value);
  }

  #add(node: ValueNode, children: readonly ValueId[]): ValueId {
    this.#assertKnownChildren(children);

    const id = this.#nodes.length;

    this.#nodes.push(node);
    this.#widthBounds.push(undefined);

    return valueId(id);
  }

  #internConst(value: number): ValueId {
    const canonical = i32(value);
    const existing = this.#constIds.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "const", value: canonical }, []);

    this.#constIds.set(canonical, id);
    return id;
  }

  #internConst64(value: bigint): ValueId {
    const canonical = BigInt.asIntN(64, value);
    const existing = this.#const64Ids.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "const64", value: canonical }, []);

    this.#const64Ids.set(canonical, id);
    return id;
  }

  #internUnreachable(type: ValueType): ValueId {
    const existing = this.#unreachableIds.get(type);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "unreachable", type }, []);

    this.#unreachableIds.set(type, id);
    return id;
  }

  #internExternal(external: ExternalValueId): ValueId {
    const existing = this.#externalIds.get(external);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "external", external }, []);

    this.#externalIds.set(external, id);
    return id;
  }

  #internBinary(
    type: ValueType,
    operator: BinaryOperator,
    a: ValueId,
    b: ValueId
  ): ValueId {
    const existing = get4(this.#binaryIds, type, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "binary", type, operator, a, b }, [a, b]);

    put4(this.#binaryIds, type, operator, a, b, id);
    return id;
  }

  #internUnary(operator: UnaryOperator, value: ValueId): ValueId {
    const existing = get2(this.#unaryIds, operator, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "unary", operator, value }, [value]);

    put2(this.#unaryIds, operator, value, id);
    return id;
  }

  #internCompare(
    type: ValueType,
    operator: CompareOperator,
    a: ValueId,
    b: ValueId
  ): ValueId {
    const existing = get4(this.#compareIds, type, operator, a, b);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "compare", type, operator, a, b }, [a, b]);

    put4(this.#compareIds, type, operator, a, b, id);
    return id;
  }

  #internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
    const existing = get3(this.#selectIds, condition, whenTrue, whenFalse);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "select", condition, whenTrue, whenFalse }, [
      condition,
      whenTrue,
      whenFalse
    ]);

    put3(this.#selectIds, condition, whenTrue, whenFalse, id);
    return id;
  }

  #internTruncate(sourceType: ValueType, width: OperandWidth, value: ValueId): ValueId {
    const existing = get3(this.#truncateIds, sourceType, width, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "truncate", sourceType, width, value }, [value]);

    put3(this.#truncateIds, sourceType, width, value, id);
    return id;
  }

  #internExtend(type: ValueType, signed: boolean, width: OperandWidth, value: ValueId): ValueId {
    const existing = get4(this.#extendIds, type, signed, width, value);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#add({ kind: "extend", type, signed, width, value }, [value]);

    put4(this.#extendIds, type, signed, width, value, id);
    return id;
  }

  #assertKnownChildren(children: readonly ValueId[]): void {
    for (const child of children) {
      assert(this.#nodes[child] !== undefined, `unknown value id ${child}`);
    }
  }

  #assertValueType(id: ValueId, expected: ValueType): void {
    const actual = this.valueType(id);

    assert(actual === expected, `value ${id} must be ${expected}, got ${actual}`);
  }

  #widthBoundsOf(id: ValueId): WidthBounds {
    const existing = this.#widthBounds[id];

    if (existing !== undefined) {
      return existing;
    }

    const derived = ValueTable.#deriveWidthBounds(
      this.node(id),
      (child) => this.#widthBoundsOf(child),
      (child) => this.constValue(child)
    );

    this.#widthBounds[id] = derived;
    return derived;
  }

  #foldContext(): ValueFoldContext {
    return {
      constValue: (id) => this.constValue(id),
      const: (value) => this.#internConst(value),
      unreachable: (type) => this.#internUnreachable(type),
      widthBounds: (id) => this.#widthBoundsOf(id)
    };
  }

  static #deriveWidthBounds(
    node: ValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds,
    constValueOf: (id: ValueId) => number | undefined
  ): WidthBounds {
    switch (node.kind) {
      case "const":
        return ValueTable.#constWidthBounds(node.value);
      case "const64":
        assert(false, "width bounds requested for i64 constant value");
      case "unreachable":
        return unboundedWidthBounds;
      case "actionOutput":
      case "loopInput":
      case "external":
        // Action and loop inputs carry their bounds from creation; externals
        // are opaque.
        return unboundedWidthBounds;
      case "binary":
        assert(node.type === "i32", `width bounds requested for ${node.type} binary value`);
        return ValueTable.#binaryWidthBounds(node, widthBoundsOf, constValueOf);
      case "select":
        return ValueTable.#selectWidthBounds(node, widthBoundsOf);
      case "unary":
        return ValueTable.#unaryWidthBounds(node, widthBoundsOf);
      case "compare":
        return fitsUnsigned(1);
      case "truncate":
        return node.sourceType === "i32"
          ? fitsUnsigned(Math.min(node.width, widthBoundsOf(node.value).unsignedBits))
          : fitsUnsigned(node.width);
      case "extend":
        assert(node.type === "i32", "width bounds requested for i64 extension value");
        return ValueTable.#extendWidthBounds(node, widthBoundsOf);
    }
  }

  static #binaryWidthBounds(
    node: BinaryValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds,
    constValueOf: (id: ValueId) => number | undefined
  ): WidthBounds {
    const a = widthBoundsOf(node.a);
    const b = widthBoundsOf(node.b);
    // Bitwise ops preserve sign extension: when the bits from position w - 1 up
    // are sign-bit copies in both operands, they still are in the result.
    const bitwiseSignedBits = Math.max(a.signedBits, b.signedBits);

    switch (node.operator) {
      case "and":
        // Can only clear bits: the tighter operand bounds the result.
        return clampedBounds(Math.min(a.unsignedBits, b.unsignedBits), bitwiseSignedBits);
      case "or":
      case "xor":
        // Cannot set a bit above either operand's bound.
        return clampedBounds(Math.max(a.unsignedBits, b.unsignedBits), bitwiseSignedBits);
      case "shr_u": {
        const shift = constValueOf(node.b);

        // Wasm masks i32 shift counts to five bits. A known right shift
        // removes that many possible high bits from an unsigned value.
        return shift === undefined
          ? clampedBounds(a.unsignedBits, 32)
          : fitsUnsigned(Math.max(1, a.unsignedBits - (shift & 31)));
      }
      case "rem_u":
        // Unsigned remainder is strictly below the divisor when it completes.
        return fitsUnsigned(b.unsignedBits);
      case "div_u":
        return fitsUnsigned(a.unsignedBits);
      case "div_s":
      case "rem_s":
      case "add":
      case "sub":
      case "mul":
      case "shl":
      case "rotl":
      case "rotr":
      case "shr_s":
        // Wrapping arithmetic has no cheap bound.
        return unboundedWidthBounds;
    }
  }

  static #selectWidthBounds(
    node: SelectValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    // The result is one of the two arms, so the weaker arm bound holds.
    const whenTrue = widthBoundsOf(node.whenTrue);
    const whenFalse = widthBoundsOf(node.whenFalse);

    return clampedBounds(
      Math.max(whenTrue.unsignedBits, whenFalse.unsignedBits),
      Math.max(whenTrue.signedBits, whenFalse.signedBits)
    );
  }

  static #unaryWidthBounds(
    node: UnaryValueNode,
    _widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    switch (node.operator) {
      case "ctz":
      case "clz":
        return fitsUnsigned(6);
      case "popcnt":
        return unboundedWidthBounds;
    }
  }

  static #extendWidthBounds(
    node: ExtendValueNode,
    widthBoundsOf: (id: ValueId) => WidthBounds
  ): WidthBounds {
    const childBounds = widthBoundsOf(node.value);

    return node.signed
      ? signExtended(Math.min(node.width, childBounds.signedBits))
      : fitsUnsigned(Math.min(node.width, childBounds.unsignedBits));
  }

  static #constWidthBounds(value: number): WidthBounds {
    return {
      // Position of the highest set bit; negative values use the sign bit.
      unsignedBits: value < 0 ? 32 : Math.max(1, 32 - Math.clz32(value)),
      // Significant bits plus the sign bit.
      signedBits: Math.min(32, 33 - Math.clz32(value ^ (value >> 31)))
    };
  }

  static #valueTypeOf(node: ValueNode): ValueType {
    switch (node.kind) {
      case "binary":
        return node.type;
      case "extend":
        return node.type;
      case "unreachable":
        return node.type;
      case "const64":
        return "i64";
      case "const":
      case "actionOutput":
      case "loopInput":
      case "external":
      case "unary":
      case "compare":
      case "select":
      case "truncate":
        return "i32";
    }
  }
}
