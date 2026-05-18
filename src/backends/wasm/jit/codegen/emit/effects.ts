import type { Effect } from "#backends/wasm/jit/codegen/plan/effect-types.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import type { CapturePlan } from "#backends/wasm/jit/codegen/plan/captures.js";
import {
  createControlEffectsEmitter,
  type JitLinkEmitContext
} from "./control-effects.js";
import { createEffectCaptureEmitter } from "./captures.js";
import type { ExitFrame } from "./exit-frame.js";
import { createMemoryEffectsEmitter } from "./memory-effects.js";
import type { ValueEmitters } from "./values.js";

export type EffectEmitter = Readonly<{
  emit(effect: Effect): void;
}>;

export type EffectEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  exitFrame: ExitFrame;
  captures: CapturePlan;
  values: ValueEmitters;
  linking?: JitLinkEmitContext | undefined;
}>;

export function createEffectEmitter(
  input: EffectEmitterInput
): EffectEmitter {
  const effectCaptures = createEffectCaptureEmitter({
    captures: input.captures
  });
  const memory = createMemoryEffectsEmitter({
    body: input.body,
    scratch: input.scratch,
    exitFrame: input.exitFrame
  });
  const control = createControlEffectsEmitter({
    body: input.body,
    scratch: input.scratch,
    frame: input.exitFrame,
    linking: input.linking
  });

  return {
    emit: (effect) => {
      const values = input.values.at(effect.at);

      effectCaptures.emitAt(effect.at, values);

      switch (effect.kind) {
        case "memoryGuard":
        case "memoryStore":
        case "memoryLoad":
          memory.emit(effect, values);
          return;
        case "jump":
        case "branch":
        case "hostTrap":
        case "fallthrough":
          control.emit(effect, values);
          return;
      }
    }
  };
}
