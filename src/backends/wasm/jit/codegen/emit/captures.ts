import type { CapturePlan, Capture } from "#backends/wasm/jit/codegen/plan/captures.js";
import type { Placement } from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { ValueEmitter } from "./values.js";

export type RuntimeCaptureEmitter = Readonly<{
  emitAt(at: Placement, values: ValueEmitter): void;
}>;

export type RuntimeCaptureEmitterInput = Readonly<{
  captures: CapturePlan;
}>;

export function createRuntimeCaptureEmitter(
  input: RuntimeCaptureEmitterInput
): RuntimeCaptureEmitter {
  return {
    emitAt: (at, values) => {
      const captures = input.captures.runtimeCaptures.get(placementKey(at)) ?? [];

      for (const capture of captures) {
        emitRuntimeCapture(capture, values);
      }
    }
  };
}

function emitRuntimeCapture(
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
  return `${placement.opIndex}:${placement.epoch}`;
}
