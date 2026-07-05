import { assert } from "#common/assert.js";
import { reg32Index } from "./registers.js";
import { segmentRegisters, type Reg32, type SegmentRegister } from "./types.js";

export const noSegmentOverride = -1;

export const dsSegmentIndex = segmentRegisterIndex("ds");
export const ssSegmentIndex = segmentRegisterIndex("ss");

const espRegisterIndex = reg32Index("esp");
const ebpRegisterIndex = reg32Index("ebp");
export const ssDefaultSegmentBaseIndexes: readonly [number, number] = [
  espRegisterIndex,
  ebpRegisterIndex
];

export function defaultSegmentForBase(base: Reg32 | undefined): SegmentRegister {
  return base === "esp" || base === "ebp" ? "ss" : "ds";
}

export function defaultSegmentIndexForBaseIndex(base: number): number {
  return ssDefaultSegmentBaseIndexes.includes(base) ? ssSegmentIndex : dsSegmentIndex;
}

export function segmentRegisterIndex(reg: SegmentRegister): number {
  const index = segmentRegisters.indexOf(reg);

  assert(index !== -1, `unknown segment register: ${reg}`);
  return index;
}
