import type { WasmMemoryImmediate } from "./memory.js";
import type { WasmValueType } from "./types.js";

export type WasmBranchHint = "unlikely" | "likely";

export interface WasmInstructionWriter {
  localGet(index: number): this;
  localSet(index: number): this;
  localTee(index: number): this;
  globalGet(index: number): this;
  globalSet(index: number): this;

  block(result?: WasmValueType): this;
  loop(): this;
  ifBlock(options?: Readonly<{
    hint?: WasmBranchHint | undefined;
    result?: WasmValueType | undefined;
  }>): this;
  elseBlock(): this;
  br(labelDepth: number): this;
  brIf(labelDepth: number, hint?: WasmBranchHint): this;
  brTable(labelDepths: readonly number[], defaultLabelDepth: number): this;
  returnFromFunction(): this;
  unreachable(): this;
  endBlock(): this;

  select(): this;
  drop(): this;
  callFunction(functionIndex: number): this;
  callIndirect(typeIndex: number, tableIndex: number): this;
  returnCallFunction(functionIndex: number): this;
  returnCallIndirect(typeIndex: number, tableIndex: number): this;

  i32Const(value: number): this;
  i64Const(value: bigint): this;

  i32Eqz(): this;
  i32Eq(): this;
  i32Ne(): this;
  i32LtS(): this;
  i32LtU(): this;
  i32GtS(): this;
  i32GtU(): this;
  i32LeS(): this;
  i32LeU(): this;
  i32GeS(): this;
  i32GeU(): this;
  i32Clz(): this;
  i32Ctz(): this;
  i32Popcnt(): this;
  i32Add(): this;
  i32Sub(): this;
  i32Mul(): this;
  i32DivS(): this;
  i32DivU(): this;
  i32RemS(): this;
  i32RemU(): this;
  i32And(): this;
  i32Or(): this;
  i32Xor(): this;
  i32Shl(): this;
  i32ShrS(): this;
  i32ShrU(): this;
  i32Rotl(): this;
  i32Rotr(): this;
  i32Extend8S(): this;
  i32Extend16S(): this;

  i32Load(immediate: WasmMemoryImmediate): this;
  i32Load8S(immediate: WasmMemoryImmediate): this;
  i32Load8U(immediate: WasmMemoryImmediate): this;
  i32Load16S(immediate: WasmMemoryImmediate): this;
  i32Load16U(immediate: WasmMemoryImmediate): this;
  i32Store(immediate: WasmMemoryImmediate): this;
  i32Store8(immediate: WasmMemoryImmediate): this;
  i32Store16(immediate: WasmMemoryImmediate): this;
  memorySize(memoryIndex: number): this;

  i64Eqz(): this;
  i64Eq(): this;
  i64Ne(): this;
  i64LtS(): this;
  i64LtU(): this;
  i64GtS(): this;
  i64GtU(): this;
  i64LeS(): this;
  i64LeU(): this;
  i64GeS(): this;
  i64GeU(): this;
  i64Clz(): this;
  i64Ctz(): this;
  i64Popcnt(): this;
  i64Add(): this;
  i64Sub(): this;
  i64Mul(): this;
  i64DivS(): this;
  i64DivU(): this;
  i64RemS(): this;
  i64RemU(): this;
  i64And(): this;
  i64Or(): this;
  i64Xor(): this;
  i64Shl(): this;
  i64ShrS(): this;
  i64ShrU(): this;
  i64Rotl(): this;
  i64Rotr(): this;

  i32WrapI64(): this;
  i64ExtendI32S(): this;
  i64ExtendI32U(): this;
}
