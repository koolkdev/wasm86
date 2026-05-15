import type { OperandWidth, Reg32 } from "#x86/isa/types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";

export type MaterializationTarget =
  | Readonly<{ kind: "reg32"; reg: Reg32 }>
  | Readonly<{ kind: "regPart"; reg: Reg32; bitOffset: number; width: OperandWidth }>
  | Readonly<{ kind: "aluFlags" }>;

export type ExitMaterializationStore = Readonly<{
  target: MaterializationTarget;
  value: JitValue;
}>;
