import { x86ArithmeticFlags } from "#x86/isa/flags.js";
import { CONDITIONS } from "./conditions.js";
import { FLAG_PRODUCERS, type FlagName } from "./flags.js";
import type {
  ConditionCode,
  FlagProducerName,
  IrBlock,
  IrOp
} from "./types.js";

export type IrFlagMask = number;

export type IrFlagOpEffect = Readonly<{
  reads: IrFlagMask;
  writes: IrFlagMask;
  undefines: IrFlagMask;
}>;

export type IrIndexedFlagPoint = Readonly<{
  index: number;
  placement: "before" | "after";
  mask: IrFlagMask;
}>;

export type IrIndexedFlagPointMasks = Readonly<{
  before: readonly IrFlagMask[];
  after: readonly IrFlagMask[];
}>;

export const IR_FLAG_MASK_NONE = 0;
export const IR_ALU_FLAGS = x86ArithmeticFlags satisfies readonly FlagName[];
export const IR_ALU_FLAG_MASKS = {
  CF: 1 << 0,
  PF: 1 << 1,
  AF: 1 << 2,
  ZF: 1 << 3,
  SF: 1 << 4,
  OF: 1 << 5
} as const satisfies Readonly<Record<FlagName, IrFlagMask>>;
export const IR_ALU_FLAG_MASK = maskIrAluFlags(IR_ALU_FLAGS);

const noFlagEffect = {
  reads: IR_FLAG_MASK_NONE,
  writes: IR_FLAG_MASK_NONE,
  undefines: IR_FLAG_MASK_NONE
} as const satisfies IrFlagOpEffect;

export function maskIrAluFlags(flags: Iterable<FlagName>): IrFlagMask {
  let mask = IR_FLAG_MASK_NONE;

  for (const flag of flags) {
    mask |= IR_ALU_FLAG_MASKS[flag];
  }

  return mask;
}

export function assertIrAluFlagMask(mask: IrFlagMask, context = "IR aluFlags mask"): void {
  if (!Number.isInteger(mask) || mask < 0 || (mask & ~IR_ALU_FLAG_MASK) !== 0) {
    throw new Error(`${context} must contain only IR aluFlags bits`);
  }
}

export function conditionFlagReadMask(cc: ConditionCode): IrFlagMask {
  return maskIrAluFlags(CONDITIONS[cc].reads);
}

export function flagProducerEffect(producer: FlagProducerName): IrFlagOpEffect {
  const flagProducer = FLAG_PRODUCERS[producer];

  return {
    reads: IR_FLAG_MASK_NONE,
    writes: flagProducer.writtenMask,
    undefines: flagProducer.undefMask
  };
}

export function irOpFlagEffect(op: IrOp): IrFlagOpEffect {
  switch (op.op) {
    case "flags.set":
      return {
        reads: IR_FLAG_MASK_NONE,
        writes: op.writtenMask,
        undefines: op.undefMask
      };
    case "flags.condition":
      return {
        reads: conditionFlagReadMask(op.cc),
        writes: IR_FLAG_MASK_NONE,
        undefines: IR_FLAG_MASK_NONE
      };
    default:
      return noFlagEffect;
  }
}

export function analyzeIrFlagEffects(block: IrBlock): readonly IrFlagOpEffect[] {
  return block.map(irOpFlagEffect);
}

export function irIndexedFlagPointMasks(
  block: IrBlock,
  points: readonly IrIndexedFlagPoint[],
  label: string
): IrIndexedFlagPointMasks {
  const before = Array.from({ length: block.length }, () => IR_FLAG_MASK_NONE);
  const after = Array.from({ length: block.length }, () => IR_FLAG_MASK_NONE);

  for (const point of points) {
    if (!Number.isInteger(point.index) || point.index < 0 || point.index >= block.length) {
      throw new Error(`${label} index out of range: ${point.index}`);
    }

    const target = point.placement === "before" ? before : after;

    assertIrAluFlagMask(point.mask, `${label} mask`);
    target[point.index] = target[point.index]! | point.mask;
  }

  return { before, after };
}
