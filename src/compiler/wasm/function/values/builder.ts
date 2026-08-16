import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { i32 } from "#common/numeric.js";
import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/types.js";
import type {
  BinaryOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import {
  binaryRequiredBits,
  constantRequiredBits,
  conversionRequiredBits,
  joinRequiredBits,
  unaryRequiredBits,
  unknownRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits
} from "./integer/required-bits.js";
import { canSpeculateIntegerBinary } from "./integer/speculation.js";
import {
  isWasmIntegerType,
  wasmIntegerTypeWidth,
  type WasmFloatType,
  type WasmValueType
} from "#wasm/types.js";
import { WasmValueGraph } from "./graph.js";
import {
  wasmValueId,
  type ComparisonNode,
  type ConstantNode,
  type ConversionNode,
  type ConversionOperator,
  type EqzNode,
  type IntegerBinaryNode,
  type SelectNode,
  type UnaryNode,
  type UnaryOperator,
  type WasmValueId,
  type WasmValueNode
} from "./nodes.js";

const noInputs: readonly [] = [];

type CanonicalNode = Extract<WasmValueNode, { kind: "const" | "unreachable" | "parameter" }>;
type OccurrenceNode = Extract<WasmValueNode, { kind: "producerOutput" | "loopInput" }>;
type OperationNode = Exclude<WasmValueNode, CanonicalNode | OccurrenceNode>;
type KeyedNode = CanonicalNode | OperationNode;

export class WasmValuesBuilder {
  readonly #nodes: WasmValueNode[] = [];
  readonly #requiredBits: (RequiredBits | undefined)[] = [];
  readonly #cannotSpeculate = new Set<WasmValueId>();
  readonly #interned = new Map<string, WasmValueId>();

  finish(): WasmValueGraph {
    return new WasmValueGraph(this.#nodes, this.#cannotSpeculate);
  }

  node(id: WasmValueId): WasmValueNode {
    const node = this.#nodes[id];

    assert(node !== undefined, `unknown Wasm value ${id}`);
    return node;
  }

  requiredBits(id: WasmValueId): RequiredBits {
    this.node(id);
    const bits = this.#requiredBits[id];

    assert(bits !== undefined, `Wasm value ${id} has no integer bit requirements`);
    return bits;
  }

  constant(value: number): WasmValueId {
    const node = {
      kind: "const",
      type: "i32",
      inputs: noInputs,
      value: i32(value)
    } as const;

    return this.#intern(node);
  }

  constant64(value: bigint): WasmValueId {
    const node = {
      kind: "const",
      type: "i64",
      inputs: noInputs,
      value: BigInt.asIntN(64, value)
    } as const;

    return this.#intern(node);
  }

  constantBits(type: WasmFloatType, bits: number | bigint): WasmValueId {
    const node: ConstantNode =
      typeof bits === "number"
        ? { kind: "const", type: "f32", inputs: noInputs, bits: bits >>> 0 }
        : { kind: "const", type: "f64", inputs: noInputs, bits: BigInt.asUintN(64, bits) };

    assert(node.type === type, `${type} constant carries ${node.type} bits`);
    return this.#intern(node);
  }

  unreachable(type: WasmValueType): WasmValueId {
    return this.#intern({
      kind: "unreachable",
      inputs: noInputs,
      type
    });
  }

  parameter(index: number, type: WasmValueType, requiredBits?: RequiredBits): WasmValueId {
    assert(Number.isInteger(index) && index >= 0, `invalid function parameter index: ${index}`);
    return this.#intern(
      {
        kind: "parameter",
        inputs: noInputs,
        index,
        type
      },
      requiredBits
    );
  }

  producerOutput(type: WasmValueType, requiredBits?: RequiredBits): WasmValueId {
    return this.#appendOccurrence(
      {
        kind: "producerOutput",
        inputs: noInputs,
        type
      },
      requiredBits
    );
  }

  loopInput(type: WasmValueType): WasmValueId {
    return this.#appendOccurrence({
      kind: "loopInput",
      inputs: noInputs,
      type
    });
  }

  unary(operator: UnaryOperator, value: WasmValueId): WasmValueId {
    const type = this.node(value).type;

    assert(isWasmIntegerType(type), "Wasm unary operations take integer operands");
    assert(
      type === "i32" || operator === "clz" || operator === "ctz" || operator === "popcnt",
      `${type}.${operator} is not a Wasm unary operation`
    );
    const node = { kind: "unary", inputs: [value], type, operator } as UnaryNode;

    return this.#operation(node);
  }

  binary(operator: BinaryOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  binary(operator: FloatBinaryOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  binary(
    operator: BinaryOperator | FloatBinaryOperator,
    a: WasmValueId,
    b: WasmValueId
  ): WasmValueId {
    const type = this.node(a).type;

    assert(this.node(b).type === type, "Wasm binary operands must have the same type");

    if (isWasmIntegerType(type)) {
      assert(operator !== "div", `${type}.${operator} is not a Wasm binary operation`);
      const node = { kind: "binary", inputs: [a, b], type, operator } as IntegerBinaryNode;

      return this.#operation(node);
    }
    assert(
      operator === "add" || operator === "sub" || operator === "mul" || operator === "div",
      `${type}.${operator} is not a Wasm binary operation`
    );
    return this.#operation({ kind: "binary", inputs: [a, b], type, operator });
  }

  compare(operator: CompareOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  compare(operator: FloatCompareOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  compare(
    operator: CompareOperator | FloatCompareOperator,
    a: WasmValueId,
    b: WasmValueId
  ): WasmValueId {
    const inputType = this.node(a).type;

    assert(this.node(b).type === inputType, "Wasm comparison operands must have the same type");
    const node = {
      kind: "compare",
      inputs: [a, b],
      type: "i32",
      inputType,
      operator
    } as ComparisonNode;

    return this.#operation(node);
  }

  eqz(value: WasmValueId): WasmValueId {
    const inputType = this.node(value).type;

    assert(isWasmIntegerType(inputType), "Wasm eqz takes an integer operand");
    const node: EqzNode = {
      kind: "eqz",
      inputs: [value],
      type: "i32",
      inputType
    };

    return this.#operation(node);
  }

  convert(operator: ConversionOperator, value: WasmValueId): WasmValueId {
    const inputType = this.node(value).type;

    assert(
      (operator === "wrap_i64" && inputType === "i64") ||
        (operator !== "wrap_i64" && inputType === "i32"),
      `${operator} cannot consume ${inputType}`
    );
    const node: ConversionNode =
      operator === "wrap_i64"
        ? { kind: "convert", inputs: [value], type: "i32", operator }
        : { kind: "convert", inputs: [value], type: "i64", operator };

    return this.#operation(node);
  }

  select(condition: WasmValueId, whenTrue: WasmValueId, whenFalse: WasmValueId): WasmValueId {
    const type = this.node(whenTrue).type;

    assert(this.node(condition).type === "i32", "Wasm select conditions must be i32");
    assert(this.node(whenFalse).type === type, "Wasm select arms must have the same type");
    const node: SelectNode = {
      kind: "select",
      inputs: [whenTrue, whenFalse, condition],
      type
    };
    return this.#operation(node);
  }

  #integerConstant(value: WasmValueId): bigint | undefined {
    const node = this.node(value);

    if (node.kind !== "const") {
      return undefined;
    }
    switch (node.type) {
      case "i32":
        return BigInt(node.value);
      case "i64":
        return node.value;
      case "f32":
      case "f64":
        return undefined;
    }
  }

  #setRequiredBits(id: WasmValueId, bits: RequiredBits): void {
    if (buildDefinition.validation) {
      const node = this.node(id);

      assert(
        isWasmIntegerType(node.type),
        `required bits are an integer fact; ${node.type} ${node.kind} has none`
      );
      const width = wasmIntegerTypeWidth(node.type);

      assert(
        bits.unsigned >= 1 &&
          bits.unsigned <= width &&
          bits.signed >= 1 &&
          bits.signed <= Math.min(width, bits.unsigned + 1),
        `${node.type} ${node.kind} has invalid required bits`
      );
    }
    this.#requiredBits[id] = bits;
  }

  #appendOccurrence(node: OccurrenceNode, requiredBits?: RequiredBits): WasmValueId {
    return this.#append(node, requiredBits);
  }

  #operation(node: OperationNode): WasmValueId {
    return this.#intern(node);
  }

  #intern(node: KeyedNode, requiredBits?: RequiredBits): WasmValueId {
    const key = internKey(node);
    const interned = this.#interned.get(key);

    if (interned !== undefined) {
      if (requiredBits !== undefined) {
        this.#setRequiredBits(interned, requiredBits);
      }
      return interned;
    }
    const id = this.#append(node, requiredBits);

    this.#interned.set(key, id);
    return id;
  }

  #append(node: WasmValueNode, declaredRequiredBits?: RequiredBits): WasmValueId {
    for (const input of node.inputs) {
      this.node(input);
    }
    const id = wasmValueId(this.#nodes.length);

    this.#nodes.push(node);
    const requiredBits = declaredRequiredBits ?? this.#deriveRequiredBits(node);

    if (requiredBits !== undefined) {
      this.#setRequiredBits(id, requiredBits);
    }
    if (!this.#canSpeculateInstruction(node)) {
      this.#cannotSpeculate.add(id);
    }
    return id;
  }

  #canSpeculateInstruction(node: WasmValueNode): boolean {
    if (node.kind === "unreachable") {
      return false;
    }
    if (node.kind !== "binary" || (node.type !== "i32" && node.type !== "i64")) {
      return true;
    }
    return canSpeculateIntegerBinary(
      node,
      this.requiredBits(node.inputs[0]),
      this.#integerConstant(node.inputs[0]),
      this.#integerConstant(node.inputs[1])
    );
  }

  #deriveRequiredBits(node: WasmValueNode): RequiredBits | undefined {
    switch (node.kind) {
      case "const":
        switch (node.type) {
          case "i32":
            return constantRequiredBits(32, node.value);
          case "i64":
            return constantRequiredBits(64, node.value);
          case "f32":
          case "f64":
            return undefined;
        }
      case "unreachable":
      case "parameter":
      case "producerOutput":
      case "loopInput":
        return isWasmIntegerType(node.type)
          ? unknownRequiredBits(wasmIntegerTypeWidth(node.type))
          : undefined;
      case "unary":
        return unaryRequiredBits(node.type, node.operator, this.requiredBits(node.inputs[0]));
      case "binary":
        if (!isWasmIntegerType(node.type)) {
          return undefined;
        }
        assert(node.operator !== "div", `${node.type}.div is not a Wasm binary operation`);
        return binaryRequiredBits(
          node.type,
          node.operator,
          this.requiredBits(node.inputs[0]),
          this.requiredBits(node.inputs[1]),
          this.#integerConstant(node.inputs[1])
        );
      case "compare":
      case "eqz":
        return zeroExtendedRequiredBits(32, 1);
      case "convert":
        return conversionRequiredBits(node.operator, this.requiredBits(node.inputs[0]));
      case "select":
        return isWasmIntegerType(node.type)
          ? joinRequiredBits(wasmIntegerTypeWidth(node.type), [
              this.requiredBits(node.inputs[0]),
              this.requiredBits(node.inputs[1])
            ])
          : undefined;
    }
  }
}

function internKey(node: KeyedNode): string {
  switch (node.kind) {
    case "const": {
      const payload = node.type === "i32" || node.type === "i64" ? node.value : node.bits;

      return `c:${node.type}:${payload}`;
    }
    case "unreachable":
      return `x:${node.type}`;
    case "parameter":
      return `p:${node.type}:${node.index}`;
    case "unary":
      return `u:${node.operator}:${node.inputs[0]}`;
    case "binary":
      return `b:${node.operator}:${node.inputs[0]}:${node.inputs[1]}`;
    case "compare":
      return `q:${node.operator}:${node.inputs[0]}:${node.inputs[1]}`;
    case "eqz":
      return `z:${node.inputs[0]}`;
    case "convert":
      return `v:${node.operator}:${node.inputs[0]}`;
    case "select":
      return `s:${node.inputs[0]}:${node.inputs[1]}:${node.inputs[2]}`;
  }
}
