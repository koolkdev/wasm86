import type { CapturePlan, Capture } from "#backends/wasm/jit/codegen/plan/captures.js";
import type { Placement } from "#backends/wasm/jit/codegen/plan/effect-types.js";
import type { ValueEmitter } from "./values.js";

export type EffectCaptureEmitter = Readonly<{
  emitAt(at: Placement, values: ValueEmitter): void;
}>;

export type EffectCaptureEmitterInput = Readonly<{
  captures: CapturePlan;
}>;

export function createEffectCaptureEmitter(
  input: EffectCaptureEmitterInput
): EffectCaptureEmitter {
  return {
    emitAt: (at, values) => {
      const captures = input.captures.effectCaptures.get(placementKey(at)) ?? [];

      for (const capture of captures) {
        emitEffectCapture(capture, values);
      }
    }
  };
}

function emitEffectCapture(
  capture: Capture,
  values: ValueEmitter
): void {
  const captured = values.capture(
    capture,
    () => values.emitInline(capture.value)
  );

  captured.release();
}

function placementKey(placement: Placement): string {
  return `${placement.instructionIndex}:${placement.opIndex}:${placement.epoch}`;
}
