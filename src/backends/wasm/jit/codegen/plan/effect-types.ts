import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { EffectKind } from "#backends/wasm/jit/analysis/effect-classifier.js";
import type { IrMemoryAccessKind } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { Exit } from "./types.js";

export type Placement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  epoch: number;
}>;

type EffectBase<TKind extends EffectKind> = Readonly<{
  kind: TKind;
  at: Placement;
}>;

export type Effect =
  | EffectBase<"memoryGuard"> & Readonly<{
      address: JitValue;
      byteLength: number;
      access: IrMemoryAccessKind;
      exit: Exit;
    }>
  | EffectBase<"memoryStore"> & Readonly<{
      address: JitValue;
      value: JitValue;
      width: OperandWidth;
    }>
  | EffectBase<"memoryLoad"> & Readonly<{
      result: JitProducedValue;
      address: JitValue;
      width: OperandWidth;
      signed: boolean;
    }>
  | EffectBase<"jump"> & Readonly<{
      target: JitValue;
      exit: Exit;
    }>
  | EffectBase<"branch"> & Readonly<{
      condition: JitValue;
      takenTarget: JitValue;
      notTakenTarget: JitValue;
      taken: Exit;
      notTaken: Exit;
    }>
  | EffectBase<"hostTrap"> & Readonly<{
      vector: JitValue;
      exit: Exit;
    }>
  | EffectBase<"fallthrough"> & Readonly<{
      exit: Exit;
    }>;

export type EffectsPlan = readonly Effect[];
