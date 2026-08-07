import type { ByteSink } from "./byte-sink.js";
import { encodeI32Leb128, encodeI64Leb128 } from "./leb128.js";
import { encodeMemoryImmediate, type WasmMemoryImmediate } from "./memory.js";
import type { WasmValueType } from "./types.js";

const emptyBlockType = 0x40;

export type WasmBranchHint = "unlikely" | "likely";

export type WasmIfInstructionOptions = Readonly<{
  hint?: WasmBranchHint | undefined;
  result?: WasmValueType | undefined;
}>;

export type WasmInstructionDescriptor<Args extends readonly unknown[]> = Readonly<{
  opcode: number;
  encodeImmediate: (body: ByteSink, ...args: Args) => void;
  branchHint?: (...args: Args) => WasmBranchHint | undefined;
}>;

function instruction<Args extends readonly unknown[]>(
  opcode: number,
  encodeImmediate: (body: ByteSink, ...args: Args) => void,
  branchHint?: (...args: Args) => WasmBranchHint | undefined
): WasmInstructionDescriptor<Args> {
  return branchHint === undefined
    ? { opcode, encodeImmediate }
    : { opcode, encodeImmediate, branchHint };
}

function plainInstruction(opcode: number): WasmInstructionDescriptor<readonly []> {
  return instruction(opcode, () => {});
}

function u32Instruction(opcode: number): WasmInstructionDescriptor<readonly [value: number]> {
  return instruction(opcode, (body, value) => {
    body.writeU32(value);
  });
}

function memoryInstruction(
  opcode: number
): WasmInstructionDescriptor<readonly [immediate: WasmMemoryImmediate]> {
  return instruction(opcode, (body, immediate) => {
    body.writeBytes(encodeMemoryImmediate(immediate));
  });
}

const blockInstruction = instruction<readonly [result?: WasmValueType]>(0x02, (body, result) => {
  body.writeByte(result ?? emptyBlockType);
});

const loopInstruction = instruction(0x03, (body) => {
  body.writeByte(emptyBlockType);
});

const ifInstruction = instruction<readonly [options?: WasmIfInstructionOptions]>(
  0x04,
  (body, options = {}) => {
    body.writeByte(options.result ?? emptyBlockType);
  },
  (options = {}) => options.hint
);

const brIfInstruction = instruction<readonly [labelDepth: number, hint?: WasmBranchHint]>(
  0x0d,
  (body, labelDepth) => {
    body.writeU32(labelDepth);
  },
  (_labelDepth, hint) => hint
);

const brTableInstruction = instruction<
  readonly [labelDepths: readonly number[], defaultLabelDepth: number]
>(0x0e, (body, labelDepths, defaultLabelDepth) => {
  body.writeVecLength(labelDepths.length);

  for (const labelDepth of labelDepths) {
    body.writeU32(labelDepth);
  }

  body.writeU32(defaultLabelDepth);
});

const callIndirectInstruction = instruction<readonly [typeIndex: number, tableIndex: number]>(
  0x11,
  (body, typeIndex, tableIndex) => {
    body.writeU32(typeIndex);
    body.writeU32(tableIndex);
  }
);

const returnCallIndirectInstruction = instruction<readonly [typeIndex: number, tableIndex: number]>(
  0x13,
  (body, typeIndex, tableIndex) => {
    body.writeU32(typeIndex);
    body.writeU32(tableIndex);
  }
);

const i32ConstInstruction = instruction<readonly [value: number]>(0x41, (body, value) => {
  body.writeBytes(encodeI32Leb128(value));
});

const i64ConstInstruction = instruction<readonly [value: bigint]>(0x42, (body, value) => {
  body.writeBytes(encodeI64Leb128(value));
});

export const wasmInstruction = {
  control: {
    block: blockInstruction,
    loop: loopInstruction,
    if: ifInstruction,
    else: plainInstruction(0x05),
    br: u32Instruction(0x0c),
    brIf: brIfInstruction,
    brTable: brTableInstruction,
    return: plainInstruction(0x0f),
    unreachable: plainInstruction(0x00),
    end: plainInstruction(0x0b)
  },
  parametric: {
    select: plainInstruction(0x1b),
    drop: plainInstruction(0x1a)
  },
  local: {
    get: u32Instruction(0x20),
    set: u32Instruction(0x21),
    tee: u32Instruction(0x22)
  },
  global: {
    get: u32Instruction(0x23),
    set: u32Instruction(0x24)
  },
  call: {
    direct: u32Instruction(0x10),
    indirect: callIndirectInstruction
  },
  returnCall: {
    direct: u32Instruction(0x12),
    indirect: returnCallIndirectInstruction
  },
  memory: {
    size: u32Instruction(0x3f)
  },
  i32: {
    const: i32ConstInstruction,
    eqz: plainInstruction(0x45),
    eq: plainInstruction(0x46),
    ne: plainInstruction(0x47),
    lt_s: plainInstruction(0x48),
    lt_u: plainInstruction(0x49),
    gt_s: plainInstruction(0x4a),
    gt_u: plainInstruction(0x4b),
    le_s: plainInstruction(0x4c),
    le_u: plainInstruction(0x4d),
    ge_s: plainInstruction(0x4e),
    ge_u: plainInstruction(0x4f),
    clz: plainInstruction(0x67),
    ctz: plainInstruction(0x68),
    popcnt: plainInstruction(0x69),
    add: plainInstruction(0x6a),
    sub: plainInstruction(0x6b),
    mul: plainInstruction(0x6c),
    div_s: plainInstruction(0x6d),
    div_u: plainInstruction(0x6e),
    rem_s: plainInstruction(0x6f),
    rem_u: plainInstruction(0x70),
    and: plainInstruction(0x71),
    or: plainInstruction(0x72),
    xor: plainInstruction(0x73),
    shl: plainInstruction(0x74),
    shr_s: plainInstruction(0x75),
    shr_u: plainInstruction(0x76),
    rotl: plainInstruction(0x77),
    rotr: plainInstruction(0x78),
    extend8S: plainInstruction(0xc0),
    extend16S: plainInstruction(0xc1),
    load: memoryInstruction(0x28),
    load8S: memoryInstruction(0x2c),
    load8U: memoryInstruction(0x2d),
    load16S: memoryInstruction(0x2e),
    load16U: memoryInstruction(0x2f),
    store: memoryInstruction(0x36),
    store8: memoryInstruction(0x3a),
    store16: memoryInstruction(0x3b),
    wrapI64: plainInstruction(0xa7)
  },
  i64: {
    const: i64ConstInstruction,
    eqz: plainInstruction(0x50),
    eq: plainInstruction(0x51),
    ne: plainInstruction(0x52),
    lt_s: plainInstruction(0x53),
    lt_u: plainInstruction(0x54),
    gt_s: plainInstruction(0x55),
    gt_u: plainInstruction(0x56),
    le_s: plainInstruction(0x57),
    le_u: plainInstruction(0x58),
    ge_s: plainInstruction(0x59),
    ge_u: plainInstruction(0x5a),
    clz: plainInstruction(0x79),
    ctz: plainInstruction(0x7a),
    popcnt: plainInstruction(0x7b),
    add: plainInstruction(0x7c),
    sub: plainInstruction(0x7d),
    mul: plainInstruction(0x7e),
    div_s: plainInstruction(0x7f),
    div_u: plainInstruction(0x80),
    rem_s: plainInstruction(0x81),
    rem_u: plainInstruction(0x82),
    and: plainInstruction(0x83),
    or: plainInstruction(0x84),
    xor: plainInstruction(0x85),
    shl: plainInstruction(0x86),
    shr_s: plainInstruction(0x87),
    shr_u: plainInstruction(0x88),
    rotl: plainInstruction(0x89),
    rotr: plainInstruction(0x8a),
    extendI32S: plainInstruction(0xac),
    extendI32U: plainInstruction(0xad)
  }
} as const;
