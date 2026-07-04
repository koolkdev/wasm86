import { ByteSink } from "./byte-sink.js";
import { encodeI32Leb128, encodeI64Leb128 } from "./leb128.js";
import { encodeMemoryImmediate, type WasmMemoryImmediate } from "./memory.js";
import { wasmBlockType, wasmOpcode, type WasmValueType } from "./types.js";

export const wasmBranchHint = {
  unlikely: 0,
  likely: 1
} as const;

export type WasmBranchHint = (typeof wasmBranchHint)[keyof typeof wasmBranchHint];

export type EncodedBranchHint = Readonly<{
  offset: number;
  value: WasmBranchHint;
}>;

export type EncodedWasmFunctionBody = Readonly<{
  bytes: Uint8Array<ArrayBuffer>;
  branchHints: readonly EncodedBranchHint[];
}>;

type InstructionBranchHint = Readonly<{
  instructionOffset: number;
  value: WasmBranchHint;
}>;

export class WasmFunctionBodyEncoder {
  readonly #instructions = new ByteSink();
  readonly #locals: WasmValueType[] = [];
  readonly #branchHints: InstructionBranchHint[] = [];
  readonly #paramCount: number;
  #ended = false;

  constructor(paramCount = 0) {
    if (!Number.isInteger(paramCount) || paramCount < 0) {
      throw new RangeError(`Wasm function parameter count out of range: ${paramCount}`);
    }

    this.#paramCount = paramCount;
  }

  addLocal(type: WasmValueType): number {
    this.#assertOpen("cannot add local after Wasm function body end");

    const index = this.#paramCount + this.#locals.length;
    this.#locals.push(type);
    return index;
  }

  localGet(index: number): this {
    this.#writeInstruction(wasmOpcode.localGet);
    this.#instructions.writeU32(index);
    return this;
  }

  localSet(index: number): this {
    this.#writeInstruction(wasmOpcode.localSet);
    this.#instructions.writeU32(index);
    return this;
  }

  localTee(index: number): this {
    this.#writeInstruction(wasmOpcode.localTee);
    this.#instructions.writeU32(index);
    return this;
  }

  globalGet(index: number): this {
    this.#writeInstruction(wasmOpcode.globalGet);
    this.#instructions.writeU32(index);
    return this;
  }

  globalSet(index: number): this {
    this.#writeInstruction(wasmOpcode.globalSet);
    this.#instructions.writeU32(index);
    return this;
  }

  block(result?: WasmValueType): this {
    this.#writeInstruction(wasmOpcode.block);
    this.#instructions.writeByte(result ?? wasmBlockType.empty);
    return this;
  }

  loop(): this {
    this.#writeInstruction(wasmOpcode.loop);
    this.#instructions.writeByte(wasmBlockType.empty);
    return this;
  }

  ifBlock(hint?: WasmBranchHint, result?: WasmValueType): this {
    if (hint !== undefined) {
      this.#branchHints.push({
        instructionOffset: this.#instructions.byteLength,
        value: hint
      });
    }

    this.#writeInstruction(wasmOpcode.if);
    this.#instructions.writeByte(result ?? wasmBlockType.empty);
    return this;
  }

  elseBlock(): this {
    this.#writeInstruction(wasmOpcode.else);
    return this;
  }

  br(labelDepth: number): this {
    this.#writeInstruction(wasmOpcode.br);
    this.#instructions.writeU32(labelDepth);
    return this;
  }

  brIf(labelDepth: number, hint?: WasmBranchHint): this {
    if (hint !== undefined) {
      this.#branchHints.push({
        instructionOffset: this.#instructions.byteLength,
        value: hint
      });
    }

    this.#writeInstruction(wasmOpcode.brIf);
    this.#instructions.writeU32(labelDepth);
    return this;
  }

  brTable(labelDepths: readonly number[], defaultLabelDepth: number): this {
    this.#writeInstruction(wasmOpcode.brTable);
    this.#instructions.writeVecLength(labelDepths.length);

    for (const labelDepth of labelDepths) {
      this.#instructions.writeU32(labelDepth);
    }

    this.#instructions.writeU32(defaultLabelDepth);
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
    this.#instructions.writeU32(functionIndex);
    return this;
  }

  callIndirect(typeIndex: number, tableIndex: number): this {
    this.#writeInstruction(wasmOpcode.callIndirect);
    this.#instructions.writeU32(typeIndex);
    this.#instructions.writeU32(tableIndex);
    return this;
  }

  returnCallFunction(functionIndex: number): this {
    this.#writeInstruction(wasmOpcode.returnCall);
    this.#instructions.writeU32(functionIndex);
    return this;
  }

  returnCallIndirect(typeIndex: number, tableIndex: number): this {
    this.#writeInstruction(wasmOpcode.returnCallIndirect);
    this.#instructions.writeU32(typeIndex);
    this.#instructions.writeU32(tableIndex);
    return this;
  }

  i32Const(value: number): this {
    this.#writeInstruction(wasmOpcode.i32Const);
    this.#instructions.writeBytes(encodeI32Leb128(value));
    return this;
  }

  i64Const(value: bigint): this {
    this.#writeInstruction(wasmOpcode.i64Const);
    this.#instructions.writeBytes(encodeI64Leb128(value));
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
    this.#writeInstruction(wasmOpcode.i32Load);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Load8S(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Load8S);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Load8U(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Load8U);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Load16S(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Load16S);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Load16U(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Load16U);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Store(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Store);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Store8(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Store8);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  i32Store16(immediate: WasmMemoryImmediate): this {
    this.#writeInstruction(wasmOpcode.i32Store16);
    this.#instructions.writeBytes(encodeMemoryImmediate(immediate));
    return this;
  }

  memorySize(memoryIndex: number): this {
    this.#writeInstruction(wasmOpcode.memorySize);
    this.#instructions.writeU32(memoryIndex);
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

  i64Or(): this {
    this.#writeInstruction(wasmOpcode.i64Or);
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

  end(): this {
    this.#writeInstruction(wasmOpcode.end);
    this.#ended = true;
    return this;
  }

  encode(): Uint8Array<ArrayBuffer> {
    return this.encodeWithMetadata().bytes;
  }

  encodeWithMetadata(): EncodedWasmFunctionBody {
    if (!this.#ended) {
      throw new Error("Wasm function body must end with end opcode");
    }

    const body = new ByteSink();
    const locals = localDeclarations(this.#locals);

    body.writeBytes(locals);
    body.writeBytes(this.#instructions.toBytes());
    return {
      bytes: body.toBytes(),
      branchHints: this.#branchHints.map((hint) => ({
        offset: locals.byteLength + hint.instructionOffset,
        value: hint.value
      }))
    };
  }

  #writeInstruction(opcode: number): void {
    this.#assertOpen("cannot write after Wasm function body end");

    this.#instructions.writeByte(opcode);
  }

  #assertOpen(message: string): void {
    if (this.#ended) {
      throw new Error(message);
    }
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
