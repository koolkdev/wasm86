import {
  jitInputAluFlagsValue
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import type { ExitStore } from "./exit-stores.js";

export function flagStores(snapshot: JitValueStateSnapshot): readonly ExitStore[] {
  const store = flagStore(snapshot);

  return store === undefined ? [] : [store];
}

export function flagStore(snapshot: JitValueStateSnapshot): ExitStore | undefined {
  const value = snapshot.flags.readAluFlags();

  if (valuesEqual(value, jitInputAluFlagsValue())) {
    return undefined;
  }

  return {
    target: { kind: "aluFlags" },
    value
  };
}
