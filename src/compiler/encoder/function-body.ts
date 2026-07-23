import { assert } from "#common/assert.js";
import { ByteSink } from "./byte-sink.js";
import { wasmInstruction } from "./instructions.js";
import {
  createWasmInstructionWriter,
  type WasmInstructionWriter
} from "./instruction-writer.js";
import type { WasmValueType } from "./types.js";

const maximumWasmIndex = 0xffff_ffff;
const wasmIndexSpaceSize = 0x1_0000_0000;

export type EncodedBranchHint = Readonly<{
  offset: number;
  value: 0 | 1;
}>;

export type EncodedWasmFunctionBody = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  branchHints: readonly EncodedBranchHint[];
}>;

export type WasmFunctionBodyLayout = Readonly<{
  // Parameters are declared by the function type but share the body's local
  // index space, so their count determines where declared locals begin.
  parameterCount: number;
  localTypes: readonly WasmValueType[];
}>;

// Maps a zero-based declared-local position into the function's local index space.
export type WasmLocalResolver = (local: number) => number;

export function encodeWasmFunctionBody(
  layout: WasmFunctionBodyLayout,
  emit: (
    writer: WasmInstructionWriter,
    resolveLocal: WasmLocalResolver
  ) => void
): EncodedWasmFunctionBody {
  const { parameterCount, localTypes } = layout;

  assert(
    Number.isInteger(parameterCount) &&
      parameterCount >= 0 &&
      parameterCount <= maximumWasmIndex,
    `Wasm function parameter count out of range: ${parameterCount}`
  );
  assert(
    parameterCount + localTypes.length <= wasmIndexSpaceSize,
    "Wasm function parameter and local counts exceed the local index space"
  );

  const body = new ByteSink();

  body.writeBytes(localDeclarations(localTypes));

  const { writer, branchHints } = createWasmInstructionWriter(body);

  emit(writer, (local) => {
    assert(
      Number.isInteger(local) && local >= 0 && local < localTypes.length,
      `Wasm function local out of range: ${local}`
    );
    return parameterCount + local;
  });
  writer.write(wasmInstruction.control.end);

  return {
    bytes: body.toBytes(),
    branchHints: [...branchHints]
  };
}

function localDeclarations(
  locals: readonly WasmValueType[]
): Uint8Array<ArrayBuffer> {
  const body = new ByteSink();
  const groups = localGroups(locals);

  body.writeVecLength(groups.length);

  for (const group of groups) {
    body.writeU32(group.count);
    body.writeByte(group.type);
  }

  return body.toBytes();
}

function localGroups(locals: readonly WasmValueType[]): readonly LocalGroup[] {
  const groups: LocalGroup[] = [];

  for (const type of locals) {
    const lastGroup = groups[groups.length - 1];

    if (lastGroup?.type === type) {
      groups[groups.length - 1] = { type, count: lastGroup.count + 1 };
    } else {
      groups.push({ type, count: 1 });
    }
  }

  return groups;
}

type LocalGroup = Readonly<{
  type: WasmValueType;
  count: number;
}>;
