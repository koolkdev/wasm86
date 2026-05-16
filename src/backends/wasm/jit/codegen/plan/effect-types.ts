import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { EffectKind } from "#backends/wasm/jit/analysis/effect-classifier.js";
import type { IrMemoryAccessKind } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { PlannedExit } from "./types.js";

export type EffectPlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  epoch: number;
}>;

type EffectBase<TKind extends EffectKind> = Readonly<{
  kind: TKind;
  at: EffectPlacement;
}>;

export type Effect =
  | EffectBase<"memoryGuard"> & Readonly<{
      address: JitValue;
      byteLength: number;
      access: IrMemoryAccessKind;
      exit: PlannedExit;
    }>
  | EffectBase<"memoryStore"> & Readonly<{
      address: JitValue;
      value: JitValue;
      accessWidth: OperandWidth;
    }>
  | EffectBase<"producedValue"> & Readonly<{
      value: JitProducedValue;
      address: JitValue;
      accessWidth: OperandWidth;
      signed: boolean;
    }>
  | EffectBase<"jump"> & Readonly<{
      target: JitValue;
      exit: PlannedExit;
    }>
  | EffectBase<"branch"> & Readonly<{
      condition: JitValue;
      takenTarget: JitValue;
      notTakenTarget: JitValue;
      taken: PlannedExit;
      notTaken: PlannedExit;
    }>
  | EffectBase<"hostTrap"> & Readonly<{
      vector: JitValue;
      exit: PlannedExit;
    }>
  | EffectBase<"fallthrough"> & Readonly<{
      exit: PlannedExit;
    }>;

export type EffectsPlan = readonly Effect[];
