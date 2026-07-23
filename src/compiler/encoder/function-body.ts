import { assert } from "#common/assert.js";
import { ByteSink } from "./byte-sink.js";
import {
  type WasmBranchHint,
  type WasmInstructionWriter
} from "./instruction-writer.js";
import { encodeI32Leb128, encodeI64Leb128 } from "./leb128.js";
import { encodeMemoryImmediate, type WasmMemoryImmediate } from "./memory.js";
import { wasmBlockType, wasmOpcode, type WasmValueType } from "./types.js";

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

  const writer = new FunctionBodyInstructionWriter(body);

  emit(writer, (local) => {
    assert(
      Number.isInteger(local) && local >= 0 && local < localTypes.length,
      `Wasm function local out of range: ${local}`
    );
    return parameterCount + local;
  });
  body.writeByte(wasmOpcode.end);

  return {
    bytes: body.toBytes(),
    branchHints: [...writer.branchHints]
  };
}

class FunctionBodyInstructionWriter implements WasmInstructionWriter {
  readonly #body: ByteSink;
  readonly #branchHints: EncodedBranchHint[] = [];

  constructor(body: ByteSink) {
    this.#body = body;
  }

  get branchHints(): readonly EncodedBranchHint[] {
    return this.#branchHints;
  }

  localGet(index: number): this {
    this.#writeInstruction(wasmOpcode.localGet);
    this.#body.writeU32(index);
    return this;
  }

  localSet(index: number): this {
    this.#writeInstruction(wasmOpcode.localSet);
    this.#body.writeU32(index);
    return this;
  }

  localTee(index: number): this {
    this.#writeInstruction(wasmOpcode.localTee);
    this.#body.writeU32(index);
    return this;
  }

  globalGet(index: number): this {
    this.#writeInstruction(wasmOpcode.globalGet);
    this.#body.writeU32(index);
    return this;
  }

  globalSet(index: number): this {
    this.#writeInstruction(wasmOpcode.globalSet);
    this.#body.writeU32(index);
    return this;
  }

  block(result?: WasmValueType): this {
    this.#writeInstruction(wasmOpcode.block);
    this.#body.writeByte(result ?? wasmBlockType.empty);
    return this;
  }

  loop(): this {
    this.#writeInstruction(wasmOpcode.loop);
    this.#body.writeByte(wasmBlockType.empty);
    return this;
  }

  ifBlock(options: Readonly<{
    hint?: WasmBranchHint | undefined;
    result?: WasmValueType | undefined;
  }> = {}): this {
    const { hint, result } = options;
    const offset = this.#body.byteLength;

    this.#writeInstruction(wasmOpcode.if);
    this.#body.writeByte(result ?? wasmBlockType.empty);
    if (hint !== undefined) {
      this.#branchHints.push({ offset, value: encodeBranchHint(hint) });
    }
    return this;
  }

  elseBlock(): this {
    this.#writeInstruction(wasmOpcode.else);
    return this;
  }

  br(labelDepth: number): this {
    this.#writeInstruction(wasmOpcode.br);
    this.#body.writeU32(labelDepth);
    return this;
  }

  brIf(labelDepth: number, hint?: WasmBranchHint): this {
    const offset = this.#body.byteLength;

    this.#writeInstruction(wasmOpcode.brIf);
    this.#body.writeU32(labelDepth);
    if (hint !== undefined) {
      this.#branchHints.push({ offset, value: encodeBranchHint(hint) });
    }
    return this;
  }

  brTable(labelDepths: readonly number[], defaultLabelDepth: number): this {
    this.#writeInstruction(wasmOpcode.brTable);
    this.#body.writeVecLength(labelDepths.length);

    for (const labelDepth of labelDepths) {
      this.#body.writeU32(labelDepth);
    }

    this.#body.writeU32(defaultLabelDepth);
    return this;
  }

  returnFromFunction(): this {
    this.#writeInstruction(wasmOpcode.return);
    return this;
  }

  unreachable(): this {
    this.#writeInstruction(wasmOpcode.unreachable);
    return this;
  }

  select(): this {
    this.#writeInstruction(wasmOpcode.select);
    return this;
  }

  drop(): this {
    this.#writeInstruction(wasmOpcode.drop);
    return this;
  }

  callFunction(functionIndex: number): this {
    this.#writeInstruction(wasmOpcode.call);
    this.#body.writeU32(functionIndex);
    return this;
  }

  callIndirect(typeIndex: number, tableIndex: number): this {
    this.#writeInstruction(wasmOpcode.callIndirect);
    this.#body.writeU32(typeIndex);
    this.#body.writeU32(tableIndex);
    return this;
  }

  returnCallFunction(functionIndex: number): this {
    this.#writeInstruction(wasmOpcode.returnCall);
    this.#body.writeU32(functionIndex);
    return this;
  }

  returnCallIndirect(typeIndex: number, tableIndex: number): this {
    this.#writeInstruction(wasmOpcode.returnCallIndirect);
    this.#body.writeU32(typeIndex);
    this.#body.writeU32(tableIndex);
    return this;
  }

  i32Const(value: number): this {
    this.#writeInstruction(wasmOpcode.i32Const);
    this.#body.writeBytes(encodeI32Leb128(value));
    return this;
  }

  i64Const(value: bigint): this {
    this.#writeInstruction(wasmOpcode.i64Const);
    this.#body.writeBytes(encodeI64Leb128(value));
    return this;
  }

  i32Eqz(): this {
    this.#writeInstruction(wasmOpcode.i32Eqz);
    return this;
  }

  i32Eq(): this {
    this.#writeInstruction(wasmOpcode.i32Eq);
    return this;
  }

  i32Ne(): this {
    this.#writeInstruction(wasmOpcode.i32Ne);
    return this;
  }

  i32LtS(): this {
    this.#writeInstruction(wasmOpcode.i32LtS);
    return this;
  }

  i32LtU(): this {
    this.#writeInstruction(wasmOpcode.i32LtU);
    return this;
  }

  i32GtS(): this {
    this.#writeInstruction(wasmOpcode.i32GtS);
    return this;
  }

  i32GtU(): this {
    this.#writeInstruction(wasmOpcode.i32GtU);
    return this;
  }

  i32LeS(): this {
    this.#writeInstruction(wasmOpcode.i32LeS);
    return this;
  }

  i32LeU(): this {
    this.#writeInstruction(wasmOpcode.i32LeU);
    return this;
  }

  i32GeS(): this {
    this.#writeInstruction(wasmOpcode.i32GeS);
    return this;
  }

  i32GeU(): this {
    this.#writeInstruction(wasmOpcode.i32GeU);
    return this;
  }

  i32Clz(): this {
    this.#writeInstruction(wasmOpcode.i32Clz);
    return this;
  }

  i32Ctz(): this {
    this.#writeInstruction(wasmOpcode.i32Ctz);
    return this;
  }

  i32Popcnt(): this {
    this.#writeInstruction(wasmOpcode.i32Popcnt);
    return this;
  }

  i32Add(): this {
    this.#writeInstruction(wasmOpcode.i32Add);
    return this;
  }

  i32Sub(): this {
    this.#writeInstruction(wasmOpcode.i32Sub);
    return this;
  }

  i32Mul(): this {
    this.#writeInstruction(wasmOpcode.i32Mul);
    return this;
  }

  i32DivS(): this {
    this.#writeInstruction(wasmOpcode.i32DivS);
    return this;
  }

  i32DivU(): this {
    this.#writeInstruction(wasmOpcode.i32DivU);
    return this;
  }

  i32RemS(): this {
    this.#writeInstruction(wasmOpcode.i32RemS);
    return this;
  }

  i32RemU(): this {
    this.#writeInstruction(wasmOpcode.i32RemU);
    return this;
  }

  i32And(): this {
    this.#writeInstruction(wasmOpcode.i32And);
    return this;
  }

  i32Or(): this {
    this.#writeInstruction(wasmOpcode.i32Or);
    return this;
  }

  i32Xor(): this {
    this.#writeInstruction(wasmOpcode.i32Xor);
    return this;
  }

  i32Shl(): this {
    this.#writeInstruction(wasmOpcode.i32Shl);
    return this;
  }

  i32ShrS(): this {
    this.#writeInstruction(wasmOpcode.i32ShrS);
    return this;
  }

  i32ShrU(): this {
    this.#writeInstruction(wasmOpcode.i32ShrU);
    return this;
  }

  i32Rotl(): this {
    this.#writeInstruction(wasmOpcode.i32Rotl);
    return this;
  }

  i32Rotr(): this {
    this.#writeInstruction(wasmOpcode.i32Rotr);
    return this;
  }

  i32Extend8S(): this {
    this.#writeInstruction(wasmOpcode.i32Extend8S);
    return this;
  }

  i32Extend16S(): this {
    this.#writeInstruction(wasmOpcode.i32Extend16S);
    return this;
  }

  i32Load(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Load, immediate);
    return this;
  }

  i32Load8S(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Load8S, immediate);
    return this;
  }

  i32Load8U(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Load8U, immediate);
    return this;
  }

  i32Load16S(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Load16S, immediate);
    return this;
  }

  i32Load16U(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Load16U, immediate);
    return this;
  }

  i32Store(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Store, immediate);
    return this;
  }

  i32Store8(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Store8, immediate);
    return this;
  }

  i32Store16(immediate: WasmMemoryImmediate): this {
    this.#writeMemoryInstruction(wasmOpcode.i32Store16, immediate);
    return this;
  }

  memorySize(memoryIndex: number): this {
    this.#writeInstruction(wasmOpcode.memorySize);
    this.#body.writeU32(memoryIndex);
    return this;
  }

  i64Eqz(): this {
    this.#writeInstruction(wasmOpcode.i64Eqz);
    return this;
  }

  i64Eq(): this {
    this.#writeInstruction(wasmOpcode.i64Eq);
    return this;
  }

  i64Ne(): this {
    this.#writeInstruction(wasmOpcode.i64Ne);
    return this;
  }

  i64LtS(): this {
    this.#writeInstruction(wasmOpcode.i64LtS);
    return this;
  }

  i64LtU(): this {
    this.#writeInstruction(wasmOpcode.i64LtU);
    return this;
  }

  i64GtS(): this {
    this.#writeInstruction(wasmOpcode.i64GtS);
    return this;
  }

  i64GtU(): this {
    this.#writeInstruction(wasmOpcode.i64GtU);
    return this;
  }

  i64LeS(): this {
    this.#writeInstruction(wasmOpcode.i64LeS);
    return this;
  }

  i64LeU(): this {
    this.#writeInstruction(wasmOpcode.i64LeU);
    return this;
  }

  i64GeS(): this {
    this.#writeInstruction(wasmOpcode.i64GeS);
    return this;
  }

  i64GeU(): this {
    this.#writeInstruction(wasmOpcode.i64GeU);
    return this;
  }

  i64Clz(): this {
    this.#writeInstruction(wasmOpcode.i64Clz);
    return this;
  }

  i64Ctz(): this {
    this.#writeInstruction(wasmOpcode.i64Ctz);
    return this;
  }

  i64Popcnt(): this {
    this.#writeInstruction(wasmOpcode.i64Popcnt);
    return this;
  }

  i64Add(): this {
    this.#writeInstruction(wasmOpcode.i64Add);
    return this;
  }

  i64Sub(): this {
    this.#writeInstruction(wasmOpcode.i64Sub);
    return this;
  }

  i64Mul(): this {
    this.#writeInstruction(wasmOpcode.i64Mul);
    return this;
  }

  i64DivS(): this {
    this.#writeInstruction(wasmOpcode.i64DivS);
    return this;
  }

  i64DivU(): this {
    this.#writeInstruction(wasmOpcode.i64DivU);
    return this;
  }

  i64RemS(): this {
    this.#writeInstruction(wasmOpcode.i64RemS);
    return this;
  }

  i64RemU(): this {
    this.#writeInstruction(wasmOpcode.i64RemU);
    return this;
  }

  i64And(): this {
    this.#writeInstruction(wasmOpcode.i64And);
    return this;
  }

  i64Or(): this {
    this.#writeInstruction(wasmOpcode.i64Or);
    return this;
  }

  i64Xor(): this {
    this.#writeInstruction(wasmOpcode.i64Xor);
    return this;
  }

  i64Shl(): this {
    this.#writeInstruction(wasmOpcode.i64Shl);
    return this;
  }

  i64ShrS(): this {
    this.#writeInstruction(wasmOpcode.i64ShrS);
    return this;
  }

  i64ShrU(): this {
    this.#writeInstruction(wasmOpcode.i64ShrU);
    return this;
  }

  i64Rotl(): this {
    this.#writeInstruction(wasmOpcode.i64Rotl);
    return this;
  }

  i64Rotr(): this {
    this.#writeInstruction(wasmOpcode.i64Rotr);
    return this;
  }

  i32WrapI64(): this {
    this.#writeInstruction(wasmOpcode.i32WrapI64);
    return this;
  }

  i64ExtendI32S(): this {
    this.#writeInstruction(wasmOpcode.i64ExtendI32S);
    return this;
  }

  i64ExtendI32U(): this {
    this.#writeInstruction(wasmOpcode.i64ExtendI32U);
    return this;
  }

  endBlock(): this {
    this.#writeInstruction(wasmOpcode.end);
    return this;
  }

  #writeMemoryInstruction(opcode: number, immediate: WasmMemoryImmediate): void {
    this.#writeInstruction(opcode);
    this.#body.writeBytes(encodeMemoryImmediate(immediate));
  }

  #writeInstruction(opcode: number): void {
    this.#body.writeByte(opcode);
  }
}

function encodeBranchHint(hint: WasmBranchHint): 0 | 1 {
  switch (hint) {
    case "unlikely":
      return 0;
    case "likely":
      return 1;
  }
}

function localDeclarations(locals: readonly WasmValueType[]): Uint8Array<ArrayBuffer> {
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
