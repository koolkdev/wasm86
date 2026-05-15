import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ok, decodeBytes } from "#x86/isa/decoder/tests/helpers.js";
import type { IrOp, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import { createCpuState, getFlag } from "#x86/state/cpu-state.js";
import { stateOffset, wasmMemoryIndex } from "#backends/wasm/abi.js";
import { wasmOpcode, wasmSectionId } from "#backends/wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { buildBlock, encodeJitBlock } from "#backends/wasm/jit/block.js";
import type { JitBlock } from "#backends/wasm/jit/block.js";
import { irOpDst, irOpIsTerminator } from "#x86/ir/model/op-semantics.js";
import { buildJitCodegenEmissionPlan } from "#backends/wasm/jit/codegen/plan/emission.js";
import { planJitCodegen } from "#backends/wasm/jit/codegen/plan/plan.js";
import { runJitBlock } from "./helpers.js";

export {
  deepStrictEqual,
  strictEqual,
  test,
  ok,
  decodeBytes,
  createCpuState,
  getFlag,
  stateOffset,
  wasmMemoryIndex,
  wasmOpcode,
  wasmSectionId,
  wasmBodyOpcodes,
  ExitReason,
  buildBlock,
  encodeJitBlock,
  irOpDst,
  irOpIsTerminator,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  runJitBlock
};
export type { IrOp, StorageRef, ValueRef };

export const startAddress = 0x1000;
export const preservedEflags = 0xffff_0000;
export const allArithmeticEflags = 0x8d5;
export const zeroFlag = 1 << 6;
export const addWraparoundEflags = 0x55;
export const subBorrowEflags = 0x95;
export const zeroResultEflags = 0x44;

export type ArithmeticFlagExpectations = Readonly<{
  CF: boolean;
  OF: boolean;
  SF: boolean;
  ZF: boolean;
  PF: boolean;
  AF: boolean;
}>;

export function assertArithmeticFlags(
  state: ReturnType<typeof createCpuState>,
  expected: ArithmeticFlagExpectations,
  label: string
): void {
  strictEqual(getFlag(state, "CF"), expected.CF, `${label} CF`);
  strictEqual(getFlag(state, "OF"), expected.OF, `${label} OF`);
  strictEqual(getFlag(state, "SF"), expected.SF, `${label} SF`);
  strictEqual(getFlag(state, "ZF"), expected.ZF, `${label} ZF`);
  strictEqual(getFlag(state, "PF"), expected.PF, `${label} PF`);
  strictEqual(getFlag(state, "AF"), expected.AF, `${label} AF`);
}

export function arithmeticEflags(flags: ArithmeticFlagExpectations): number {
  return (
    (flags.CF ? 0x001 : 0) |
    (flags.PF ? 0x004 : 0) |
    (flags.AF ? 0x010 : 0) |
    (flags.ZF ? 0x040 : 0) |
    (flags.SF ? 0x080 : 0) |
    (flags.OF ? 0x800 : 0)
  ) >>> 0;
}

export function codegenIr(block: ReturnType<typeof buildBlock>): readonly IrOp[] {
  return blockIr(block);
}

export function blockIr(block: JitBlock): readonly IrOp[] {
  return block.instructions.flatMap((instruction) => instruction.ir);
}

export function constValue(value: ValueRef): number | undefined {
  return value.kind === "const" ? value.value : undefined;
}

export function littleEndianBytes(value: number, width: 8 | 16 | 32): readonly number[] {
  const byteCount = width / 8;

  return Array.from({ length: byteCount }, (_, index) => (value >>> (index * 8)) & 0xff);
}

export function readGuestValue(view: DataView, address: number, width: 8 | 16 | 32): number {
  switch (width) {
    case 8:
      return view.getUint8(address);
    case 16:
      return view.getUint16(address, true);
    case 32:
      return view.getUint32(address, true);
  }
}

export function decodedBlock(instructionBytes: readonly (readonly number[])[]): ReturnType<typeof buildBlock> {
  const instructions = [];
  let decodeEip = startAddress;

  for (const bytes of instructionBytes) {
    const instruction = ok(decodeBytes(bytes, decodeEip));

    instructions.push(instruction);
    decodeEip = instruction.nextEip;
  }

  return buildBlock(instructions);
}

export function singleInstructionBodyOpcodes(bytes: readonly number[]): readonly number[] {
  return jitBlockBodyOpcodes(buildBlock([ok(decodeBytes(bytes, startAddress))]));
}

export function jitBlockBodyOpcodes(block: ReturnType<typeof buildBlock>): readonly number[] {
  return wasmBodyOpcodes(extractOnlyFunctionBody(encodeJitBlock([block])));
}

export function assertNoMaskImmediatelyAfter(opcodes: readonly number[], opcode: number): void {
  const index = requiredOpcodeIndex(opcodes, opcode);

  strictEqual(opcodes[index + 1] === wasmOpcode.i32Const && opcodes[index + 2] === wasmOpcode.i32And, false);
}

export function assertNoOperandMaskBefore(opcodes: readonly number[], opcode: number): void {
  const index = requiredOpcodeIndex(opcodes, opcode);

  strictEqual(opcodes.slice(Math.max(0, index - 3), index).includes(wasmOpcode.i32And), false);
}

export function requiredOpcodeIndex(opcodes: readonly number[], opcode: number): number {
  const index = opcodes.indexOf(opcode);

  if (index === -1) {
    throw new Error(`missing Wasm opcode in JIT body: 0x${opcode.toString(16)}`);
  }

  return index;
}

export function opcodeIndexes(opcodes: readonly number[], opcode: number): readonly number[] {
  const indexes: number[] = [];

  for (let index = 0; index < opcodes.length; index += 1) {
    if (opcodes[index] === opcode) {
      indexes.push(index);
    }
  }

  return indexes;
}

export function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodeIndexes(opcodes, opcode).length;
}

export function irOpDstId(op: IrOp): readonly number[] {
  const dst = irOpDst(op);

  return dst === undefined ? [] : [dst.id];
}

export function irOpOperandIndexes(op: IrOp): readonly number[] {
  switch (op.op) {
    case "get":
      return storageOperandIndexes(op.source);
    case "set":
      return storageOperandIndexes(op.target);
    case "address":
      return [op.operand.index];
    default:
      return [];
  }
}

export function storageOperandIndexes(storage: StorageRef): readonly number[] {
  switch (storage.kind) {
    case "operand":
      return [storage.index];
    case "mem":
      return [];
    case "reg":
      return [];
  }
}

export function aluFlagMemoryAccessCounts(block: ReturnType<typeof buildBlock>): Readonly<{ loads: number; stores: number }> {
  let loads = 0;
  let stores = 0;

  for (const access of memoryAccesses(extractOnlyFunctionBody(encodeJitBlock([block])))) {
    if (access.memoryIndex !== 0 || access.offset !== stateOffset.aluFlags) {
      continue;
    }

    if (access.opcode === wasmOpcode.i32Load) {
      loads += 1;
    } else if (access.opcode === wasmOpcode.i32Store) {
      stores += 1;
    }
  }

  return { loads, stores };
}

export function stateMemoryLoads(block: ReturnType<typeof buildBlock>): readonly number[] {
  return memoryAccesses(extractOnlyFunctionBody(encodeJitBlock([block])))
    .filter((access) => access.memoryIndex === 0 && access.opcode === wasmOpcode.i32Load)
    .map((access) => access.offset);
}

export function registerStateMemoryAccesses(
  block: ReturnType<typeof buildBlock>,
  regOffset: number
): readonly Readonly<{ opcode: number; offset: number }>[] {
  return memoryAccesses(extractOnlyFunctionBody(encodeJitBlock([block])))
    .filter((access) =>
      access.memoryIndex === wasmMemoryIndex.state &&
      access.offset >= regOffset &&
      access.offset < regOffset + 4
    )
    .map((access) => ({ opcode: access.opcode, offset: access.offset }));
}

export type WasmMemoryAccess = Readonly<{
  opcode: number;
  memoryIndex: number;
  offset: number;
}>;

export function memoryAccesses(functionBody: Uint8Array<ArrayBuffer>): readonly WasmMemoryAccess[] {
  const accesses: WasmMemoryAccess[] = [];
  let offset = skipLocalDeclarations(functionBody);

  while (offset < functionBody.length) {
    const opcode = requiredByte(functionBody, offset);

    offset += 1;

    switch (opcode) {
      case wasmOpcode.localGet:
      case wasmOpcode.localSet:
      case wasmOpcode.localTee:
      case wasmOpcode.br:
      case wasmOpcode.call:
      case wasmOpcode.returnCall:
      case wasmOpcode.memorySize:
        offset = readU32Leb128(functionBody, offset).nextOffset;
        break;
      case wasmOpcode.brTable: {
        const tableLength = readU32Leb128(functionBody, offset);

        offset = tableLength.nextOffset;

        for (let index = 0; index < tableLength.value; index += 1) {
          offset = readU32Leb128(functionBody, offset).nextOffset;
        }

        offset = readU32Leb128(functionBody, offset).nextOffset;
        break;
      }
      case wasmOpcode.block:
      case wasmOpcode.loop:
      case wasmOpcode.if:
        offset += 1;
        break;
      case wasmOpcode.i32Const:
      case wasmOpcode.i64Const:
        offset = skipLeb128(functionBody, offset);
        break;
      case wasmOpcode.i32Load:
      case wasmOpcode.i32Load8S:
      case wasmOpcode.i32Load8U:
      case wasmOpcode.i32Load16S:
      case wasmOpcode.i32Load16U:
      case wasmOpcode.i32Store:
      case wasmOpcode.i32Store8:
      case wasmOpcode.i32Store16: {
        const memory = readMemoryImmediate(functionBody, offset);

        offset = memory.nextOffset;
        accesses.push({
          opcode,
          memoryIndex: memory.memoryIndex,
          offset: memory.offset
        });
        break;
      }
      case wasmOpcode.else:
      case wasmOpcode.return:
      case wasmOpcode.drop:
      case wasmOpcode.select:
      case wasmOpcode.i32Eqz:
      case wasmOpcode.i32LtU:
      case wasmOpcode.i32GtU:
      case wasmOpcode.i32Popcnt:
      case wasmOpcode.i32Add:
      case wasmOpcode.i32Sub:
      case wasmOpcode.i32And:
      case wasmOpcode.i32Or:
      case wasmOpcode.i32Xor:
      case wasmOpcode.i32Shl:
      case wasmOpcode.i32ShrU:
      case wasmOpcode.i64Or:
      case wasmOpcode.i64ExtendI32U:
      case wasmOpcode.i32Extend8S:
      case wasmOpcode.i32Extend16S:
      case wasmOpcode.end:
        break;
      default:
        throw new Error(`unsupported Wasm opcode in JIT block test: 0x${opcode.toString(16)}`);
    }
  }

  return accesses;
}

export function extractOnlyFunctionBody(moduleBytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let offset = 8;

  while (offset < moduleBytes.length) {
    const sectionId = requiredByte(moduleBytes, offset);
    const sectionSize = readU32Leb128(moduleBytes, offset + 1);
    const sectionStart = sectionSize.nextOffset;
    const sectionEnd = sectionStart + sectionSize.value;

    if (sectionId === wasmSectionId.code) {
      const functionCount = readU32Leb128(moduleBytes, sectionStart);

      strictEqual(functionCount.value, 1);

      const bodySize = readU32Leb128(moduleBytes, functionCount.nextOffset);
      const bodyStart = bodySize.nextOffset;

      return moduleBytes.slice(bodyStart, bodyStart + bodySize.value);
    }

    offset = sectionEnd;
  }

  throw new Error("missing Wasm code section");
}

export function skipLocalDeclarations(bytes: Uint8Array<ArrayBuffer>): number {
  const groupCount = readU32Leb128(bytes, 0);
  let offset = groupCount.nextOffset;

  for (let index = 0; index < groupCount.value; index += 1) {
    const groupSize = readU32Leb128(bytes, offset);

    offset = groupSize.nextOffset + 1;
  }

  return offset;
}

export function readMemoryImmediate(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): Readonly<{ memoryIndex: number; offset: number; nextOffset: number }> {
  const align = readU32Leb128(bytes, offset);
  const hasMemoryIndex = (align.value & 0x40) !== 0;

  if (!hasMemoryIndex) {
    const memoryOffset = readU32Leb128(bytes, align.nextOffset);

    return { memoryIndex: 0, offset: memoryOffset.value, nextOffset: memoryOffset.nextOffset };
  }

  const memoryIndex = readU32Leb128(bytes, align.nextOffset);
  const memoryOffset = readU32Leb128(bytes, memoryIndex.nextOffset);

  return { memoryIndex: memoryIndex.value, offset: memoryOffset.value, nextOffset: memoryOffset.nextOffset };
}

export function skipLeb128(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  while ((requiredByte(bytes, offset) & 0x80) !== 0) {
    offset += 1;
  }

  return offset + 1;
}

export function readU32Leb128(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number
): Readonly<{ value: number; nextOffset: number }> {
  let value = 0;
  let shift = 0;

  while (true) {
    const byte = requiredByte(bytes, offset);

    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value: value >>> 0, nextOffset: offset };
    }

    shift += 7;
  }
}

export function requiredByte(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  const byte = bytes[offset];

  if (byte === undefined) {
    throw new Error(`unexpected end of Wasm bytes at offset ${offset}`);
  }

  return byte;
}
