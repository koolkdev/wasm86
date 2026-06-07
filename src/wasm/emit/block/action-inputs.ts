import { assert } from "#common/assert.js";
import type { BlockActionSite } from "#ir/block/timeline.js";
import type { LayoutTimelineInput } from "#ir/block/planning/layout/index.js";
import type {
  WasmActionInputRole,
  WasmActionOperands,
  WasmLayoutInputEmitter
} from "./types.js";
import type { WasmValueCacheLocalEmission } from "../cache/locals/index.js";

export type WasmActionOperandsInput = Readonly<{
  site: BlockActionSite;
  inputs: readonly LayoutTimelineInput[];
  emitStackInput: WasmLayoutInputEmitter;
  emitLocalInput(input: LayoutTimelineInput): WasmValueCacheLocalEmission;
}>;

export function createWasmActionOperands(input: WasmActionOperandsInput): WasmActionOperands {
  const locals = new Map<WasmActionInputRole, WasmValueCacheLocalEmission>();
  let released = false;

  return {
    has: (role) => actionInputForRole(input.inputs, role) !== undefined,
    emitStack: (role) => {
      const layoutInput = actionInputForRole(input.inputs, role);

      assert(layoutInput !== undefined, `layout action has no ${role} input for ${input.site.action.kind}`);
      return input.emitStackInput(layoutInput);
    },
    emitLocal: (role) => {
      const existing = locals.get(role);

      if (existing !== undefined) {
        return existing;
      }

      const layoutInput = actionInputForRole(input.inputs, role);

      assert(layoutInput !== undefined, `layout action has no ${role} input for ${input.site.action.kind}`);

      const local = input.emitLocalInput(layoutInput);

      locals.set(role, local);
      return local;
    },
    local: (role) => {
      const local = locals.get(role);

      assert(local !== undefined, `layout action has no local ${role} input for ${input.site.action.kind}`);
      return local;
    },
    release: () => {
      if (released) {
        return;
      }

      released = true;

      for (const local of locals.values()) {
        local.release();
      }

      locals.clear();
    }
  };
}

function actionInputForRole(
  inputs: readonly LayoutTimelineInput[],
  role: WasmActionInputRole
): LayoutTimelineInput | undefined {
  return inputs.find((candidate) =>
    candidate.use.kind === "action-input" &&
    candidate.use.role === role
  );
}
