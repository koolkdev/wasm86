import type {
  FlagStateTarget,
  RegisterStateTarget,
  StateTarget
} from "#ir/block/state/targets.js";
import type { WasmEmittedValue } from "../values/types.js";

export type WasmTargetValueProducer = () => WasmEmittedValue;

export type WasmTargetStorage<Target extends StateTarget = StateTarget> = Readonly<{
  emitLoad(target: Target): WasmEmittedValue;
  emitStore(target: Target, emitValue: WasmTargetValueProducer): void;
}>;

export type WasmTargetStorageInput = Readonly<{
  registers: WasmTargetStorage<RegisterStateTarget>;
  flags: WasmTargetStorage<FlagStateTarget>;
}>;

export function createWasmTargetStorage(input: WasmTargetStorageInput): WasmTargetStorage {
  return {
    emitLoad: (target) => {
      switch (target.kind) {
        case "reg":
          return input.registers.emitLoad(target);
        case "flag":
          return input.flags.emitLoad(target);
        default:
          return unsupportedStateTarget(target);
      }
    },
    emitStore: (target, emitValue) => {
      switch (target.kind) {
        case "reg":
          input.registers.emitStore(target, emitValue);
          return;
        case "flag":
          input.flags.emitStore(target, emitValue);
          return;
        default:
          unsupportedStateTarget(target);
      }
    }
  };
}

function unsupportedStateTarget(target: never): never {
  const kind = (target as { kind?: string }).kind ?? "<missing>";

  throw new Error(`unsupported StateTarget kind: ${kind}`);
}
