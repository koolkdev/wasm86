import type { BlockScheduleEntry } from "#backends/wasm/jit/codegen/plan/schedule-types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { CapturePlan } from "#backends/wasm/jit/codegen/plan/captures.js";
import {
  createControlActionEmitter,
  type JitLinkEmitContext
} from "./control-actions.js";
import { createRuntimeCaptureEmitter } from "./captures.js";
import type { ExitFrame } from "./exit-frame.js";
import { createMemoryActionEmitter } from "./memory-actions.js";
import { createMemoryDefinitionEmitter } from "./memory-definitions.js";
import type { ValueEmitters } from "./values.js";

export type ScheduleEmitter = Readonly<{
  emit(entry: BlockScheduleEntry): void;
}>;

export type ScheduleEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  exitFrame: ExitFrame;
  captures: CapturePlan;
  values: ValueEmitters;
  linking?: JitLinkEmitContext | undefined;
}>;

export function createScheduleEmitter(
  input: ScheduleEmitterInput
): ScheduleEmitter {
  const runtimeCaptures = createRuntimeCaptureEmitter({
    captures: input.captures
  });
  const memory = createMemoryActionEmitter({
    body: input.body,
    scratch: input.scratch,
    exitFrame: input.exitFrame
  });
  const control = createControlActionEmitter({
    body: input.body,
    scratch: input.scratch,
    frame: input.exitFrame,
    linking: input.linking
  });
  const definitions = createMemoryDefinitionEmitter({
    body: input.body
  });

  return {
    emit: (entry) => {
      const values = input.values.at(entry.at);

      runtimeCaptures.emitAt(entry.at, values);

      switch (entry.kind) {
        case "memoryGuard":
        case "memoryStore":
          memory.emit(entry, values);
          return;
        case "jump":
        case "branch":
        case "hostTrap":
        case "fallthrough":
          control.emit(entry, values);
          return;
        case "defineLoadResult":
          definitions.emit(entry, values);
          return;
      }
    }
  };
}
