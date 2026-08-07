import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { i32 } from "#common/numeric.js";
import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/type.js";
import {
  constantRequiredBits,
  joinRequiredBits,
  unknownRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits
} from "./integer/required-bits.js";
import type {
  BinaryOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import {
  isWasmIntegerType,
  wasmIntegerTypeWidth,
  type WasmFloatType,
  type WasmIntegerType,
  type WasmValueType
} from "#wasm/types.js";
import { binaryInstructionCanSpeculate, binaryRequiredBits } from "./integer/binary.js";
import { conversionRequiredBits } from "./integer/conversion.js";
import { WasmValueGraph } from "./graph.js";
import {
  wasmValueId,
  type WasmValueId,
  type WasmValueNode,
  type ComparisonNode,
  type ConstantNode,
  type ConversionNode,
  type ConversionOperator,
  type EqzNode,
  type IntegerBinaryNode,
  type SelectNode,
  type UnaryNode,
  type UnaryOperator
} from "./nodes.js";
import { unaryRequiredBits } from "./integer/unary.js";
import { packWasmValueFacts, WasmValueFacts } from "./facts.js";

const noInputs: readonly [] = [];

type CanonicalNode = Extract<WasmValueNode, { kind: "const" | "unreachable" | "parameter" }>;
type OccurrenceNode = Extract<WasmValueNode, { kind: "producerOutput" | "loopInput" }>;
type OperationNode = Exclude<WasmValueNode, CanonicalNode | OccurrenceNode>;
type KeyedNode = CanonicalNode | OperationNode;

export class WasmValuesBuilder {
  readonly #nodes: WasmValueNode[] = [];
  readonly #facts: number[] = [];
  // Required-bit facts are stored beside the integer values that establish them.
  readonly #requiredBits: RequiredBits[] = [];
  readonly #interned = new Map<string, WasmValueId>();

  finish(): Readonly<{ graph: WasmValueGraph; facts: WasmValueFacts }> {
    return {
      graph: new WasmValueGraph(this.#nodes),
      facts: new WasmValueFacts(this.#facts)
    };
  }

  node(id: WasmValueId): WasmValueNode {
    const node = this.#nodes[id];

    assert(node !== undefined, `unknown Wasm value ${id}`);
    return node;
  }

  requiredBits(id: WasmValueId): RequiredBits {
    this.node(id);
    const bits = this.#requiredBits[id];

    assert(bits !== undefined, `required bits are an integer fact; Wasm value ${id} has none`);
    return bits;
  }

  constant(value: number): WasmValueId {
    const node = {
      kind: "const",
      type: "i32",
      inputs: noInputs,
      value: i32(value)
    } as const;

    return this.#integerBits(this.#intern(node), constantRequiredBits(32, node.value));
  }

  constant64(value: bigint): WasmValueId {
    const node = {
      kind: "const",
      type: "i64",
      inputs: noInputs,
      value: BigInt.asIntN(64, value)
    } as const;

    return this.#integerBits(this.#intern(node), constantRequiredBits(64, node.value));
  }

  // A bit-pattern payload is the Wasm type's own constant form, so a folded
  // constant and its literal intern as one value and ±0 stay distinct.
  constantBits(type: WasmFloatType, bits: number | bigint): WasmValueId {
    const node: ConstantNode =
      typeof bits === "number"
        ? { kind: "const", type: "f32", inputs: noInputs, bits: bits >>> 0 }
        : { kind: "const", type: "f64", inputs: noInputs, bits: BigInt.asUintN(64, bits) };

    assert(node.type === type, `${type} constant carries ${node.type} bits`);
    return this.#intern(node);
  }

  unreachable(type: WasmValueType): WasmValueId {
    // Unreachable is the canonical bottom value for each Wasm value type.
    return this.#typeBits(
      this.#intern(
        {
          kind: "unreachable",
          inputs: noInputs,
          type
        },
        false
      ),
      type
    );
  }

  parameter(index: number, type: WasmValueType, requiredBits?: RequiredBits): WasmValueId {
    assert(Number.isInteger(index) && index >= 0, `invalid function parameter index: ${index}`);
    const id = this.#intern({
      kind: "parameter",
      inputs: noInputs,
      index,
      type
    });

    return requiredBits === undefined
      ? this.#typeBits(id, type)
      : this.#integerBits(id, requiredBits);
  }

  producerOutput(
    type: WasmValueType,
    requiredLoopDepth: number,
    requiredBits?: RequiredBits
  ): WasmValueId {
    const id = this.#occurrence(
      {
        kind: "producerOutput",
        inputs: noInputs,
        type
      },
      requiredLoopDepth
    );

    return requiredBits === undefined
      ? this.#typeBits(id, type)
      : this.#integerBits(id, requiredBits);
  }

  loopInput(type: WasmValueType, requiredLoopDepth: number): WasmValueId {
    return this.#typeBits(
      this.#occurrence(
        {
          kind: "loopInput",
          inputs: noInputs,
          type
        },
        requiredLoopDepth
      ),
      type
    );
  }

  unary(operator: UnaryOperator, value: WasmValueId): WasmValueId {
    const type = this.#integerTypeOf(value);

    assert(
      type === "i32" || operator === "clz" || operator === "ctz" || operator === "popcnt",
      `${type}.${operator} is not a Wasm unary operation`
    );
    const node = { kind: "unary", inputs: [value], type, operator } as UnaryNode;

    return this.#integerBits(this.#operation(node), unaryRequiredBits(node, this));
  }

  binary(operator: BinaryOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  binary(operator: FloatBinaryOperator, a: WasmValueId, b: WasmValueId): WasmValueId;
  binary(
    operator: BinaryOperator | FloatBinaryOperator,
    a: WasmValueId,
    b: WasmValueId
  ): WasmValueId {
    const type = this.#sameType(a, b);

    if (isWasmIntegerType(type)) {
      // "div" is the one operator the integer alphabet does not spell.
      assert(operator !== "div", `${type}.${operator} is not a Wasm binary operation`);
      const node: IntegerBinaryNode = { kind: "binary", inputs: [a, b], type, operator };
      const bits = binaryRequiredBits(node, this);
      const instructionCanSpeculate = binaryInstructionCanSpeculate(node, this);

      return this.#integerBits(this.#operation(node, instructionCanSpeculate), bits);
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
    const inputType = this.#sameType(a, b);
    // The operand type picks the alphabet; every comparison produces one bit.
    const node = {
      kind: "compare",
      inputs: [a, b],
      type: "i32",
      inputType,
      operator
    } as ComparisonNode;

    return this.#integerBits(this.#operation(node), zeroExtendedRequiredBits(32, 1));
  }

  eqz(value: WasmValueId): WasmValueId {
    const inputType = this.#integerTypeOf(value);
    const node: EqzNode = {
      kind: "eqz",
      inputs: [value],
      type: "i32",
      inputType
    };

    return this.#integerBits(this.#operation(node), zeroExtendedRequiredBits(32, 1));
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

    return this.#integerBits(this.#operation(node), conversionRequiredBits(node, this));
  }

  select(condition: WasmValueId, whenTrue: WasmValueId, whenFalse: WasmValueId): WasmValueId {
    this.#expectType(condition, "i32");
    const type = this.#sameType(whenTrue, whenFalse);
    const node: SelectNode = {
      kind: "select",
      inputs: [whenTrue, whenFalse, condition],
      type
    };

    // A select is bounded by its arms; required-bit facts exist only for integers.
    if (!isWasmIntegerType(type)) {
      return this.#operation(node);
    }
    const bits = joinRequiredBits(wasmIntegerTypeWidth(type), [
      this.requiredBits(whenTrue),
      this.requiredBits(whenFalse)
    ]);

    return this.#integerBits(this.#operation(node), bits);
  }

  #integerTypeOf(value: WasmValueId): WasmIntegerType {
    const type = this.node(value).type;

    assert(isWasmIntegerType(type), "wasm integer operations take integer operands");
    return type;
  }

  #sameType(a: WasmValueId, b: WasmValueId): WasmValueType {
    const type = this.node(a).type;

    this.#expectType(b, type);
    return type;
  }

  #expectType(value: WasmValueId, expected: WasmValueType): void {
    if (!buildDefinition.validation) {
      return;
    }
    const actual = this.node(value).type;

    assert(actual === expected, `Wasm value ${value} must be ${expected}, got ${actual}`);
  }

  // A mint that states no tighter bound is bounded by its Wasm integer type;
  // float values do not have required-bit facts.
  #typeBits(id: WasmValueId, type: WasmValueType): WasmValueId {
    return isWasmIntegerType(type)
      ? this.#integerBits(id, unknownRequiredBits(wasmIntegerTypeWidth(type)))
      : id;
  }

  #integerBits(id: WasmValueId, bits: RequiredBits): WasmValueId {
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
    return id;
  }

  #occurrence(node: OccurrenceNode, requiredLoopDepth: number): WasmValueId {
    return this.#append(node, true, requiredLoopDepth);
  }

  #operation(node: OperationNode, instructionCanSpeculate = true): WasmValueId {
    return this.#intern(node, instructionCanSpeculate);
  }

  #intern(node: KeyedNode, instructionCanSpeculate = true): WasmValueId {
    const key = internKey(node);
    const interned = this.#interned.get(key);

    if (interned !== undefined) {
      return interned;
    }
    const id = this.#append(node, instructionCanSpeculate);

    this.#interned.set(key, id);
    return id;
  }

  #append(
    node: WasmValueNode,
    instructionCanSpeculate: boolean,
    minimumLoopDepth = 0
  ): WasmValueId {
    let requiredLoopDepth = minimumLoopDepth;

    for (const input of node.inputs) {
      this.node(input);
      const inputFacts = this.#facts[input];

      assert(inputFacts !== undefined, `facts entry missing for Wasm value ${input}`);
      requiredLoopDepth = Math.max(requiredLoopDepth, inputFacts >>> 2);
    }
    const id = wasmValueId(this.#nodes.length);

    this.#nodes.push(node);
    const recipeCanSpeculate =
      instructionCanSpeculate && node.inputs.every((input) => (this.#facts[input]! & 2) !== 0);

    this.#facts.push(
      packWasmValueFacts(instructionCanSpeculate, recipeCanSpeculate, requiredLoopDepth)
    );
    return id;
  }
}

// Injective: the one-character tag fixes the kind and arity, and no part —
// Wasm type, operator, decimal id, index or constant — can contain the separator.
// The type is spelled only where the operands do not already determine it.
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
