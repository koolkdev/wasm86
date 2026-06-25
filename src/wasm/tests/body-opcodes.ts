import { wasmOpcode, wasmSectionId } from "#wasm/encoder/types.js";

export type WasmBodyMemoryAccess = Readonly<{
  opcode: number;
  memoryIndex: number;
  offset: number;
}>;

export type WasmBodyInstruction = Readonly<{
  offset: number;
  opcode: number;
  local?: number;
}>;

export function extractOnlyWasmFunctionBody(moduleBytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let offset = 8;

  while (offset < moduleBytes.length) {
    const sectionId = requiredByte(moduleBytes, offset);
    const sectionSize = readU32Leb128(moduleBytes, offset + 1);
    const sectionStart = sectionSize.nextOffset;
    const sectionEnd = sectionStart + sectionSize.value;

    if (sectionId === wasmSectionId.code) {
      const functionCount = readU32Leb128(moduleBytes, sectionStart);

      if (functionCount.value !== 1) {
        throw new Error(`expected exactly one Wasm function body, got ${functionCount.value}`);
      }

      const bodySize = readU32Leb128(moduleBytes, functionCount.nextOffset);
      const bodyStart = bodySize.nextOffset;

      return moduleBytes.slice(bodyStart, bodyStart + bodySize.value);
    }

    offset = sectionEnd;
  }

  throw new Error("missing Wasm code section");
}

export function wasmDefinedFunctionCount(moduleBytes: Uint8Array<ArrayBuffer>): number {
  let offset = 8;

  while (offset < moduleBytes.length) {
    const sectionId = requiredByte(moduleBytes, offset);
    const sectionSize = readU32Leb128(moduleBytes, offset + 1);
    const sectionStart = sectionSize.nextOffset;
    const sectionEnd = sectionStart + sectionSize.value;

    if (sectionId === wasmSectionId.function) {
      return readU32Leb128(moduleBytes, sectionStart).value;
    }

    offset = sectionEnd;
  }

  throw new Error("missing Wasm function section");
}

export function wasmBodyOpcodes(functionBody: Uint8Array<ArrayBuffer>): readonly number[] {
  const opcodes: number[] = [];
  let offset = skipLocalDeclarations(functionBody);

  while (offset < functionBody.length) {
    const opcode = requiredByte(functionBody, offset);

    opcodes.push(opcode);
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
      case wasmOpcode.i32Store16:
        offset = skipMemoryImmediate(functionBody, offset);
        break;
      case wasmOpcode.else:
      case wasmOpcode.unreachable:
      case wasmOpcode.return:
      case wasmOpcode.drop:
      case wasmOpcode.select:
      case wasmOpcode.i32Eqz:
      case wasmOpcode.i32Eq:
      case wasmOpcode.i32Ne:
      case wasmOpcode.i32LtS:
      case wasmOpcode.i32LtU:
      case wasmOpcode.i32GtS:
      case wasmOpcode.i32GtU:
      case wasmOpcode.i32LeS:
      case wasmOpcode.i32LeU:
      case wasmOpcode.i32GeS:
      case wasmOpcode.i32GeU:
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
        throw new Error(`unsupported Wasm opcode in test body: 0x${opcode.toString(16)}`);
    }
  }

  return opcodes;
}

export function wasmBodyInstructions(functionBody: Uint8Array<ArrayBuffer>): readonly WasmBodyInstruction[] {
  const instructions: WasmBodyInstruction[] = [];
  let offset = skipLocalDeclarations(functionBody);

  while (offset < functionBody.length) {
    const instructionOffset = offset;
    const opcode = requiredByte(functionBody, offset);

    offset += 1;

    switch (opcode) {
      case wasmOpcode.localGet:
      case wasmOpcode.localSet:
      case wasmOpcode.localTee: {
        const local = readU32Leb128(functionBody, offset);

        instructions.push({ offset: instructionOffset, opcode, local: local.value });
        offset = local.nextOffset;
        break;
      }
      case wasmOpcode.br:
      case wasmOpcode.call:
      case wasmOpcode.returnCall:
      case wasmOpcode.memorySize:
        instructions.push({ offset: instructionOffset, opcode });
        offset = readU32Leb128(functionBody, offset).nextOffset;
        break;
      case wasmOpcode.brTable: {
        const tableLength = readU32Leb128(functionBody, offset);

        instructions.push({ offset: instructionOffset, opcode });
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
        instructions.push({ offset: instructionOffset, opcode });
        offset += 1;
        break;
      case wasmOpcode.i32Const:
      case wasmOpcode.i64Const:
        instructions.push({ offset: instructionOffset, opcode });
        offset = skipLeb128(functionBody, offset);
        break;
      case wasmOpcode.i32Load:
      case wasmOpcode.i32Load8S:
      case wasmOpcode.i32Load8U:
      case wasmOpcode.i32Load16S:
      case wasmOpcode.i32Load16U:
      case wasmOpcode.i32Store:
      case wasmOpcode.i32Store8:
      case wasmOpcode.i32Store16:
        instructions.push({ offset: instructionOffset, opcode });
        offset = skipMemoryImmediate(functionBody, offset);
        break;
      default:
        instructions.push({ offset: instructionOffset, opcode });
        break;
    }
  }

  return instructions;
}

export function wasmBodyMemoryAccesses(functionBody: Uint8Array<ArrayBuffer>): readonly WasmBodyMemoryAccess[] {
  const accesses: WasmBodyMemoryAccess[] = [];
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
      case wasmOpcode.i32Store16:
        {
          const memory = readMemoryImmediate(functionBody, offset);

          offset = memory.nextOffset;
          accesses.push({
            opcode,
            memoryIndex: memory.memoryIndex,
            offset: memory.offset
          });
        }
        break;
      case wasmOpcode.else:
      case wasmOpcode.unreachable:
      case wasmOpcode.return:
      case wasmOpcode.drop:
      case wasmOpcode.select:
      case wasmOpcode.i32Eqz:
      case wasmOpcode.i32Eq:
      case wasmOpcode.i32Ne:
      case wasmOpcode.i32LtS:
      case wasmOpcode.i32LtU:
      case wasmOpcode.i32GtS:
      case wasmOpcode.i32GtU:
      case wasmOpcode.i32LeS:
      case wasmOpcode.i32LeU:
      case wasmOpcode.i32GeS:
      case wasmOpcode.i32GeU:
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
        throw new Error(`unsupported Wasm opcode in test body: 0x${opcode.toString(16)}`);
    }
  }

  return accesses;
}

export function wasmBodyLocalCount(functionBody: Uint8Array<ArrayBuffer>): number {
  const groups = readU32Leb128(functionBody, 0);
  let total = 0;
  let offset = groups.nextOffset;

  for (let index = 0; index < groups.value; index += 1) {
    const groupSize = readU32Leb128(functionBody, offset);

    total += groupSize.value;
    offset = groupSize.nextOffset + 1;
  }

  return total;
}

export function wasmOpcodeIsLocalWrite(opcode: number): boolean {
  return opcode === wasmOpcode.localTee || opcode === wasmOpcode.localSet;
}

function skipLocalDeclarations(bytes: Uint8Array<ArrayBuffer>): number {
  const groupCount = readU32Leb128(bytes, 0);
  let offset = groupCount.nextOffset;

  for (let index = 0; index < groupCount.value; index += 1) {
    const groupSize = readU32Leb128(bytes, offset);

    offset = groupSize.nextOffset + 1;
  }

  return offset;
}

function skipMemoryImmediate(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  return readMemoryImmediate(bytes, offset).nextOffset;
}

function readMemoryImmediate(
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

  return {
    memoryIndex: memoryIndex.value,
    offset: memoryOffset.value,
    nextOffset: memoryOffset.nextOffset
  };
}

function skipLeb128(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  while ((requiredByte(bytes, offset) & 0x80) !== 0) {
    offset += 1;
  }

  return offset + 1;
}

function readU32Leb128(
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

function requiredByte(bytes: Uint8Array<ArrayBuffer>, offset: number): number {
  const byte = bytes[offset];

  if (byte === undefined) {
    throw new Error(`unexpected end of Wasm bytes at offset ${offset}`);
  }

  return byte;
}
