import type { BitValue } from "#compiler/function/values.js";
import type { InstructionStateChannel } from "./state/channels.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { InstructionState } from "./state/state.js";
import { StateLoopScope } from "./state/loop-scope.js";

type BuildLoopContext = Readonly<{
  state: InstructionState;
  parentRegion: RegionBuilder;
}>;

type BuildLoopBody = (region: RegionBuilder, finish: (condition: BitValue) => void) => void;

export function buildLoop(
  context: BuildLoopContext,
  bodyWrites: readonly InstructionStateChannel[],
  buildBody: BuildLoopBody
): void {
  const { parentRegion, state } = context;
  const scope = new StateLoopScope(state, bodyWrites);
  const parentAccess = state.forRegion(parentRegion);
  const carried = scope.begin(parentAccess);

  parentRegion.loop(
    carried.map((value) => value.seed),
    (region, inputs) => {
      const access = state.forRegion(region);

      scope.enter(access, inputs);
      buildBody(region, (condition) => {
        const exitValues = scope.captureExitValues(access);

        region.if(condition, (taken) => {
          taken.loopContinue(exitValues);
        });

        for (const writeback of scope.exitWritebacks(access, exitValues)) {
          writeback.emit(region);
        }
        scope.close();
      });
    },
    {
      resourceReadPlacement: (effect) => scope.resourceReadPlacement(effect)
    }
  );
}
