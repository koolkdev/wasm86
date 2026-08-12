import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { i32 } from "#common/numeric.js";
import {
  constantRequiredBits,
  unknownRequiredBits,
  type RequiredBits
} from "./integer/required-bits.js";
import {
  isWasmIntegerType,
  wasmIntegerTypeWidth,
  type WasmFloatType,
  type WasmValueType
} from "#wasm/types.js";
import { WasmValueGraph } from "./graph.js";
import { wasmValueId, type ConstantNode, type WasmValueId, type WasmValueNode } from "./nodes.js";

const noInputs: readonly [] = [];

type CanonicalNode = Extract<WasmValueNode, { kind: "const" | "unreachable" | "parameter" }>;
type OccurrenceNode = Extract<WasmValueNode, { kind: "producerOutput" | "loopInput" }>;

export class WasmValuesBuilder {
  readonly #nodes: WasmValueNode[] = [];
  readonly #requiredBits: (RequiredBits | undefined)[] = [];
  readonly #interned = new Map<string, WasmValueId>();

  finish(): WasmValueGraph {
    return new WasmValueGraph(this.#nodes);
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

    return this.#recordRequiredBits(this.#intern(node), constantRequiredBits(32, node.value));
  }

  constant64(value: bigint): WasmValueId {
    const node = {
      kind: "const",
      type: "i64",
      inputs: noInputs,
      value: BigInt.asIntN(64, value)
    } as const;

    return this.#recordRequiredBits(this.#intern(node), constantRequiredBits(64, node.value));
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
    return this.#recordDefaultRequiredBits(
      this.#intern({
        kind: "unreachable",
        inputs: noInputs,
        type
      }),
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
      ? this.#recordDefaultRequiredBits(id, type)
      : this.#recordRequiredBits(id, requiredBits);
  }

  producerOutput(type: WasmValueType, requiredBits?: RequiredBits): WasmValueId {
    const id = this.#appendOccurrence({
      kind: "producerOutput",
      inputs: noInputs,
      type
    });

    return requiredBits === undefined
      ? this.#recordDefaultRequiredBits(id, type)
      : this.#recordRequiredBits(id, requiredBits);
  }

  loopInput(type: WasmValueType): WasmValueId {
    return this.#recordDefaultRequiredBits(
      this.#appendOccurrence({
        kind: "loopInput",
        inputs: noInputs,
        type
      }),
      type
    );
  }

  #recordDefaultRequiredBits(id: WasmValueId, type: WasmValueType): WasmValueId {
    return isWasmIntegerType(type)
      ? this.#recordRequiredBits(id, unknownRequiredBits(wasmIntegerTypeWidth(type)))
      : id;
  }

  #recordRequiredBits(id: WasmValueId, bits: RequiredBits): WasmValueId {
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

  #appendOccurrence(node: OccurrenceNode): WasmValueId {
    return this.#append(node);
  }

  #intern(node: CanonicalNode): WasmValueId {
    const key = internKey(node);
    const interned = this.#interned.get(key);

    if (interned !== undefined) {
      return interned;
    }
    const id = this.#append(node);

    this.#interned.set(key, id);
    return id;
  }

  #append(node: WasmValueNode): WasmValueId {
    for (const input of node.inputs) {
      this.node(input);
    }
    const id = wasmValueId(this.#nodes.length);

    this.#nodes.push(node);
    return id;
  }
}

function internKey(node: CanonicalNode): string {
  switch (node.kind) {
    case "const": {
      const payload = node.type === "i32" || node.type === "i64" ? node.value : node.bits;

      return `c:${node.type}:${payload}`;
    }
    case "unreachable":
      return `x:${node.type}`;
    case "parameter":
      return `p:${node.type}:${node.index}`;
  }
}
