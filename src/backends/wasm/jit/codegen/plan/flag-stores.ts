import {
  jitInputAluFlagsValue
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { JitFlagSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";

export type FlagExitStore = Readonly<{
  target: JitFlagSlot;
  value: JitValue;
}>;

export function flagStores(snapshot: JitValueStateSnapshot): readonly FlagExitStore[] {
  const store = flagStore(snapshot);

  return store === undefined ? [] : [store];
}

export function flagStoreSourceRequiredMask(_target: JitFlagSlot): number {
  return 0xffff_ffff;
}

export function flagStore(snapshot: JitValueStateSnapshot): FlagExitStore | undefined {
  const value = snapshot.flags.readAluFlags();

  if (valuesEqual(value, jitInputAluFlagsValue())) {
    return undefined;
  }

  return {
    target: { kind: "aluFlags" },
    value
  };
}
