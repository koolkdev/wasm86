import { assert } from "#common/assert.js";
import type { CompareOperator, UnaryOperator } from "#ir/operators.js";
import type { ValueTable } from "#ir/value-table.js";
import {
  valueChildren,
  valueId,
  type BinaryValueNode,
  type ValueId,
  type ValueNode
} from "#ir/values.js";

// Whether evaluating a value and its complete dependency closure can execute
// without a Wasm trap. Value ids are topological, so one ascending pass is
// enough to classify every child before its wrapper.
export class ValueTraits {
  readonly #values: ValueTable;
  readonly #intrinsicallyNonTrapping: readonly boolean[];
  readonly #nonTrapping: readonly boolean[];

  constructor(values: ValueTable) {
    const intrinsicallyNonTrapping: boolean[] = [];
    const nonTrapping: boolean[] = [];

    for (let rawId = 0; rawId < values.size(); rawId += 1) {
      const node = values.node(valueId(rawId));
      const intrinsic = ValueTraits.#isIntrinsicallyNonTrapping(values, node);

      intrinsicallyNonTrapping.push(intrinsic);
      nonTrapping.push(intrinsic && valueChildren(node).every((child) => (
        nonTrapping[child] === true
      )));
    }

    this.#values = values;
    this.#intrinsicallyNonTrapping = intrinsicallyNonTrapping;
    this.#nonTrapping = nonTrapping;
  }

  isNonTrapping(id: ValueId): boolean {
    const nonTrapping = this.#nonTrapping[id];

    assert(nonTrapping !== undefined, `no evaluation traits for value ${id}`);
    return nonTrapping;
  }

  // A value already evaluated on the current path is replayed from its local,
  // so it cuts off a possibly trapping dependency closure. This query keeps
  // that path state outside the static traits analysis.
  canEvaluateWithoutTrap(id: ValueId, isAlreadyBound: (value: ValueId) => boolean): boolean {
    this.isNonTrapping(id);

    const contextual = new Map<ValueId, boolean>();
    const visit = (value: ValueId): boolean => {
      const existing = contextual.get(value);

      if (existing !== undefined) {
        return existing;
      }

      if (this.#nonTrapping[value] === true || isAlreadyBound(value)) {
        contextual.set(value, true);
        return true;
      }

      const result = this.#intrinsicallyNonTrapping[value] === true &&
        valueChildren(this.#values.node(value)).every(visit);

      contextual.set(value, result);
      return result;
    };

    return visit(id);
  }

  static #isIntrinsicallyNonTrapping(values: ValueTable, node: ValueNode): boolean {
    switch (node.kind) {
      case "const":
      case "const64":
      case "external":
      case "actionOutput":
      case "loopInput":
      case "select":
      case "truncate":
      case "extend":
        return true;
      case "unreachable":
        return false;
      case "binary":
        return ValueTraits.#binaryIsIntrinsicallyNonTrapping(values, node);
      case "unary":
        return ValueTraits.#unaryOperatorIsNonTrapping(node.operator);
      case "compare":
        return ValueTraits.#compareOperatorIsNonTrapping(node.operator);
    }
  }

  static #binaryIsIntrinsicallyNonTrapping(
    values: ValueTable,
    node: BinaryValueNode
  ): boolean {
    switch (node.operator) {
      case "div_u":
      case "rem_s":
      case "rem_u": {
        const divisor = ValueTraits.#constantValue(values, node.b);

        return divisor !== undefined && divisor !== 0n;
      }
      case "div_s": {
        const divisor = ValueTraits.#constantValue(values, node.b);

        if (divisor === undefined || divisor === 0n) {
          return false;
        }

        if (divisor !== -1n) {
          return true;
        }

        const dividend = ValueTraits.#constantValue(values, node.a);
        const minimum = node.type === "i32" ? -0x8000_0000n : -0x8000_0000_0000_0000n;

        return dividend !== undefined && dividend !== minimum;
      }
      case "add":
      case "sub":
      case "mul":
      case "xor":
      case "or":
      case "and":
      case "shl":
      case "rotl":
      case "rotr":
      case "shr_s":
      case "shr_u":
        return true;
    }
  }

  static #constantValue(values: ValueTable, id: ValueId): bigint | undefined {
    const node = values.node(id);

    switch (node.kind) {
      case "const":
        return BigInt(node.value);
      case "const64":
        return node.value;
      default:
        return undefined;
    }
  }

  static #unaryOperatorIsNonTrapping(operator: UnaryOperator): boolean {
    switch (operator) {
      case "popcnt":
      case "ctz":
      case "clz":
        return true;
    }
  }

  static #compareOperatorIsNonTrapping(operator: CompareOperator): boolean {
    switch (operator) {
      case "eq":
      case "ne":
      case "lt_u":
      case "le_u":
      case "gt_u":
      case "ge_u":
      case "lt_s":
      case "le_s":
      case "gt_s":
      case "ge_s":
        return true;
    }
  }
}
