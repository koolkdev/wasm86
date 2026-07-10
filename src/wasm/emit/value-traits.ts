import { assert } from "#common/assert.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#ir/operators.js";
import type { ValueTable } from "#ir/value-table.js";
import { valueChildren, valueId, type ValueId, type ValueNode } from "#ir/values.js";

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
      const intrinsic = ValueTraits.#isIntrinsicallyNonTrapping(node);

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

  static #isIntrinsicallyNonTrapping(node: ValueNode): boolean {
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
        return ValueTraits.#binaryOperatorIsNonTrapping(node.operator);
      case "unary":
        return ValueTraits.#unaryOperatorIsNonTrapping(node.operator);
      case "compare":
        return ValueTraits.#compareOperatorIsNonTrapping(node.operator);
    }
  }

  static #binaryOperatorIsNonTrapping(operator: BinaryOperator): boolean {
    switch (operator) {
      case "div_s":
      case "div_u":
      case "rem_s":
      case "rem_u":
        return false;
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
