import type { ByteSink } from "./byte-sink.js";
import { encodeI32Leb128, encodeI64Leb128 } from "./leb128.js";
import { encodeMemoryImmediate, type WasmMemoryImmediate } from "./memory.js";
import {
  wasmBlockType,
  wasmOpcode,
  type WasmValueType
} from "./types.js";

export type WasmBranchHint = "unlikely" | "likely";

export type WasmIfInstructionOptions = Readonly<{
  hint?: WasmBranchHint | undefined;
  result?: WasmValueType | undefined;
}>;

export type WasmInstruction<
  Args extends readonly unknown[]
> = Readonly<{
  opcode: number;
  encodeImmediate: (body: ByteSink, ...args: Args) => void;
  branchHint?: (...args: Args) => WasmBranchHint | undefined;
}>;

function instruction<Args extends readonly unknown[]>(
  opcode: number,
  encodeImmediate: (body: ByteSink, ...args: Args) => void,
  branchHint?: (...args: Args) => WasmBranchHint | undefined
): WasmInstruction<Args> {
  return branchHint === undefined
    ? { opcode, encodeImmediate }
    : { opcode, encodeImmediate, branchHint };
}

function plainInstruction(opcode: number): WasmInstruction<readonly []> {
  return instruction(opcode, () => {});
}

function u32Instruction(
  opcode: number
): WasmInstruction<readonly [value: number]> {
  return instruction(opcode, (body, value) => {
    body.writeU32(value);
  });
}

function memoryInstruction(
  opcode: number
): WasmInstruction<readonly [immediate: WasmMemoryImmediate]> {
  return instruction(opcode, (body, immediate) => {
    body.writeBytes(encodeMemoryImmediate(immediate));
  });
}

const blockInstruction = instruction<readonly [result?: WasmValueType]>(
  wasmOpcode.block,
  (body, result) => {
    body.writeByte(result ?? wasmBlockType.empty);
  }
);

const loopInstruction = instruction(wasmOpcode.loop, (body) => {
  body.writeByte(wasmBlockType.empty);
});

const ifInstruction = instruction<
  readonly [options?: WasmIfInstructionOptions]
>(
  wasmOpcode.if,
  (body, options = {}) => {
    body.writeByte(options.result ?? wasmBlockType.empty);
  },
  (options = {}) => options.hint
);

const brIfInstruction = instruction<
  readonly [labelDepth: number, hint?: WasmBranchHint]
>(
  wasmOpcode.brIf,
  (body, labelDepth) => {
    body.writeU32(labelDepth);
  },
  (_labelDepth, hint) => hint
);

const brTableInstruction = instruction<
  readonly [labelDepths: readonly number[], defaultLabelDepth: number]
>(wasmOpcode.brTable, (body, labelDepths, defaultLabelDepth) => {
  body.writeVecLength(labelDepths.length);

  for (const labelDepth of labelDepths) {
    body.writeU32(labelDepth);
  }

  body.writeU32(defaultLabelDepth);
});

const callIndirectInstruction = instruction<
  readonly [typeIndex: number, tableIndex: number]
>(wasmOpcode.callIndirect, (body, typeIndex, tableIndex) => {
  body.writeU32(typeIndex);
  body.writeU32(tableIndex);
});

const returnCallIndirectInstruction = instruction<
  readonly [typeIndex: number, tableIndex: number]
>(wasmOpcode.returnCallIndirect, (body, typeIndex, tableIndex) => {
  body.writeU32(typeIndex);
  body.writeU32(tableIndex);
});

const i32ConstInstruction = instruction<readonly [value: number]>(
  wasmOpcode.i32Const,
  (body, value) => {
    body.writeBytes(encodeI32Leb128(value));
  }
);

const i64ConstInstruction = instruction<readonly [value: bigint]>(
  wasmOpcode.i64Const,
  (body, value) => {
    body.writeBytes(encodeI64Leb128(value));
  }
);

export const wasmInstruction = {
  control: {
    block: blockInstruction,
    loop: loopInstruction,
    if: ifInstruction,
    else: plainInstruction(wasmOpcode.else),
    br: u32Instruction(wasmOpcode.br),
    brIf: brIfInstruction,
    brTable: brTableInstruction,
    return: plainInstruction(wasmOpcode.return),
    unreachable: plainInstruction(wasmOpcode.unreachable),
    end: plainInstruction(wasmOpcode.end)
  },
  parametric: {
    select: plainInstruction(wasmOpcode.select),
    drop: plainInstruction(wasmOpcode.drop)
  },
  local: {
    get: u32Instruction(wasmOpcode.localGet),
    set: u32Instruction(wasmOpcode.localSet),
    tee: u32Instruction(wasmOpcode.localTee)
  },
  global: {
    get: u32Instruction(wasmOpcode.globalGet),
    set: u32Instruction(wasmOpcode.globalSet)
  },
  call: {
    direct: u32Instruction(wasmOpcode.call),
    indirect: callIndirectInstruction
  },
  returnCall: {
    direct: u32Instruction(wasmOpcode.returnCall),
    indirect: returnCallIndirectInstruction
  },
  memory: {
    size: u32Instruction(wasmOpcode.memorySize)
  },
  i32: {
    const: i32ConstInstruction,
    eqz: plainInstruction(wasmOpcode.i32Eqz),
    eq: plainInstruction(wasmOpcode.i32Eq),
    ne: plainInstruction(wasmOpcode.i32Ne),
    lt_s: plainInstruction(wasmOpcode.i32LtS),
    lt_u: plainInstruction(wasmOpcode.i32LtU),
    gt_s: plainInstruction(wasmOpcode.i32GtS),
    gt_u: plainInstruction(wasmOpcode.i32GtU),
    le_s: plainInstruction(wasmOpcode.i32LeS),
    le_u: plainInstruction(wasmOpcode.i32LeU),
    ge_s: plainInstruction(wasmOpcode.i32GeS),
    ge_u: plainInstruction(wasmOpcode.i32GeU),
    clz: plainInstruction(wasmOpcode.i32Clz),
    ctz: plainInstruction(wasmOpcode.i32Ctz),
    popcnt: plainInstruction(wasmOpcode.i32Popcnt),
    add: plainInstruction(wasmOpcode.i32Add),
    sub: plainInstruction(wasmOpcode.i32Sub),
    mul: plainInstruction(wasmOpcode.i32Mul),
    div_s: plainInstruction(wasmOpcode.i32DivS),
    div_u: plainInstruction(wasmOpcode.i32DivU),
    rem_s: plainInstruction(wasmOpcode.i32RemS),
    rem_u: plainInstruction(wasmOpcode.i32RemU),
    and: plainInstruction(wasmOpcode.i32And),
    or: plainInstruction(wasmOpcode.i32Or),
    xor: plainInstruction(wasmOpcode.i32Xor),
    shl: plainInstruction(wasmOpcode.i32Shl),
    shr_s: plainInstruction(wasmOpcode.i32ShrS),
    shr_u: plainInstruction(wasmOpcode.i32ShrU),
    rotl: plainInstruction(wasmOpcode.i32Rotl),
    rotr: plainInstruction(wasmOpcode.i32Rotr),
    extend8S: plainInstruction(wasmOpcode.i32Extend8S),
    extend16S: plainInstruction(wasmOpcode.i32Extend16S),
    load: memoryInstruction(wasmOpcode.i32Load),
    load8S: memoryInstruction(wasmOpcode.i32Load8S),
    load8U: memoryInstruction(wasmOpcode.i32Load8U),
    load16S: memoryInstruction(wasmOpcode.i32Load16S),
    load16U: memoryInstruction(wasmOpcode.i32Load16U),
    store: memoryInstruction(wasmOpcode.i32Store),
    store8: memoryInstruction(wasmOpcode.i32Store8),
    store16: memoryInstruction(wasmOpcode.i32Store16),
    wrapI64: plainInstruction(wasmOpcode.i32WrapI64)
  },
  i64: {
    const: i64ConstInstruction,
    eqz: plainInstruction(wasmOpcode.i64Eqz),
    eq: plainInstruction(wasmOpcode.i64Eq),
    ne: plainInstruction(wasmOpcode.i64Ne),
    lt_s: plainInstruction(wasmOpcode.i64LtS),
    lt_u: plainInstruction(wasmOpcode.i64LtU),
    gt_s: plainInstruction(wasmOpcode.i64GtS),
    gt_u: plainInstruction(wasmOpcode.i64GtU),
    le_s: plainInstruction(wasmOpcode.i64LeS),
    le_u: plainInstruction(wasmOpcode.i64LeU),
    ge_s: plainInstruction(wasmOpcode.i64GeS),
    ge_u: plainInstruction(wasmOpcode.i64GeU),
    clz: plainInstruction(wasmOpcode.i64Clz),
    ctz: plainInstruction(wasmOpcode.i64Ctz),
    popcnt: plainInstruction(wasmOpcode.i64Popcnt),
    add: plainInstruction(wasmOpcode.i64Add),
    sub: plainInstruction(wasmOpcode.i64Sub),
    mul: plainInstruction(wasmOpcode.i64Mul),
    div_s: plainInstruction(wasmOpcode.i64DivS),
    div_u: plainInstruction(wasmOpcode.i64DivU),
    rem_s: plainInstruction(wasmOpcode.i64RemS),
    rem_u: plainInstruction(wasmOpcode.i64RemU),
    and: plainInstruction(wasmOpcode.i64And),
    or: plainInstruction(wasmOpcode.i64Or),
    xor: plainInstruction(wasmOpcode.i64Xor),
    shl: plainInstruction(wasmOpcode.i64Shl),
    shr_s: plainInstruction(wasmOpcode.i64ShrS),
    shr_u: plainInstruction(wasmOpcode.i64ShrU),
    rotl: plainInstruction(wasmOpcode.i64Rotl),
    rotr: plainInstruction(wasmOpcode.i64Rotr),
    extendI32S: plainInstruction(wasmOpcode.i64ExtendI32S),
    extendI32U: plainInstruction(wasmOpcode.i64ExtendI32U)
  }
} as const;
