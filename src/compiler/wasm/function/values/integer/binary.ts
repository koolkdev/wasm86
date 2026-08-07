import { assert } from "#common/assert.js";
import type { BinaryOperator } from "#compiler/function/values/integer/operators.js";
import { wasmIntegerTypeWidth, type WasmIntegerWidth } from "#wasm/types.js";
import type { WasmValueId } from "../nodes.js";
import {
  clampRequiredBits,
  mayContainSignedMinimum,
  unknownRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits,
  type RequiredBitsQuery
} from "./required-bits.js";
import type { WasmValueNode, IntegerBinaryNode, IntegerConstantNode } from "../nodes.js";

type BinaryQuery = RequiredBitsQuery &
  Readonly<{
    node(id: WasmValueId): WasmValueNode;
  }>;

export function binaryRequiredBits(node: IntegerBinaryNode, query: BinaryQuery): RequiredBits {
  const [a, b] = node.inputs;
  const left = query.requiredBits(a);
  const right = query.requiredBits(b);
  const width = wasmIntegerTypeWidth(node.type);

  return resultRequiredBits(width, node.operator, left, right, shiftConstant(query, b, width));
}

export function binaryInstructionCanSpeculate(
  node: IntegerBinaryNode,
  query: BinaryQuery
): boolean {
  const [a, b] = node.inputs;

  switch (node.operator) {
    case "div_s": {
      const divisor = integerConstant(node, query, b);

      if (divisor === undefined) {
        return false;
      }
      if (divisor === 0n) {
        return false;
      }
      if (divisor !== -1n) {
        return true;
      }
      const dividend = integerConstant(node, query, a);
      const minimum = node.type === "i32" ? -0x8000_0000n : -0x8000_0000_0000_0000n;

      if (dividend !== undefined) {
        return dividend !== minimum;
      }
      const bits = query.requiredBits(a);
      const width = wasmIntegerTypeWidth(node.type);

      return !mayContainSignedMinimum(bits, width);
    }
    case "div_u":
    case "rem_s":
    case "rem_u": {
      const divisor = integerConstant(node, query, b);

      return divisor !== undefined && divisor !== 0n;
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

function shiftConstant(
  query: BinaryQuery,
  id: WasmValueId,
  width: WasmIntegerWidth
): number | undefined {
  const constant = constantNode(query, id);

  if (constant === undefined) {
    return undefined;
  }
  const value = constant.type === "i32" ? BigInt(constant.value) : constant.value;

  return Number(value & BigInt(width - 1));
}

function resultRequiredBits(
  width: WasmIntegerWidth,
  operator: BinaryOperator,
  left: RequiredBits,
  right: RequiredBits,
  shift: number | undefined
): RequiredBits {
  switch (operator) {
    case "xor":
    case "or":
      return clampRequiredBits(
        width,
        Math.max(left.unsigned, right.unsigned),
        Math.max(left.signed, right.signed)
      );
    case "and":
      return clampRequiredBits(
        width,
        Math.min(left.unsigned, right.unsigned),
        Math.max(left.signed, right.signed)
      );
    case "shl":
      return shift === undefined
        ? unknownRequiredBits(width)
        : zeroExtendedRequiredBits(width, left.unsigned + shift);
    case "shr_u":
      return shift === undefined
        ? clampRequiredBits(width, left.unsigned, width)
        : zeroExtendedRequiredBits(width, Math.max(1, left.unsigned - shift));
    case "div_u":
      return zeroExtendedRequiredBits(width, left.unsigned);
    case "rem_u":
      return zeroExtendedRequiredBits(width, right.unsigned);
    case "add":
    case "sub":
    case "mul":
    case "div_s":
    case "rem_s":
    case "rotl":
    case "rotr":
    case "shr_s":
      return unknownRequiredBits(width);
  }
}

function integerConstant(
  operation: IntegerBinaryNode,
  query: BinaryQuery,
  id: WasmValueId
): bigint | undefined {
  const constant = constantNode(query, id);

  if (constant === undefined) {
    return undefined;
  }
  assert(constant.type === operation.type, `Wasm value ${id} must be ${operation.type}`);
  return constant.type === "i32" ? BigInt(constant.value) : constant.value;
}

function constantNode(query: BinaryQuery, id: WasmValueId): IntegerConstantNode | undefined {
  const node = query.node(id);

  // Required-bit facts exist only for integers; the type test narrows the payload.
  return node.kind === "const" && (node.type === "i32" || node.type === "i64") ? node : undefined;
}
