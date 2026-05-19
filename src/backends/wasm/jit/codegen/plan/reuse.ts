import {
  planCache,
  type CachePlan
} from "./cache.js";
import {
  planCaptures,
  type CapturePlan
} from "./captures.js";
import { storeClobberValues } from "./store-strategy.js";
import {
  buildEpochs,
  type EpochUsePlan,
  type InstructionEpochs,
  type InstructionEpochInput,
  type PlacedLoadResultDefinition
} from "./epochs.js";
import {
  type ValueUse
} from "./value-uses.js";
import type { PlannedExit } from "./types.js";

export type {
  CachePlan,
  EpochPlan,
  SelectedValue
} from "./cache.js";
export type {
  Capture,
  CaptureMap,
  CapturePlan,
  CaptureReason,
  InstructionCaptureMap
} from "./captures.js";
export type {
  EpochUsePlan,
  InstructionEpochSource,
  InstructionEpochs,
  InstructionEpochInput,
  PlacedLoadResultDefinition
} from "./epochs.js";

export type ReuseInput = Readonly<{
  uses: readonly ValueUse[];
  epochs: readonly EpochUsePlan[];
  loadResults: readonly PlacedLoadResultDefinition[];
  exits: readonly PlannedExit[];
}>;

export type ReusePlan = Readonly<{
  cache: CachePlan;
  captures: CapturePlan;
}>;

export type InstructionReusePlan = ReusePlan & Readonly<{
  instructions: readonly InstructionEpochs[];
}>;

export function planReuse(input: ReuseInput): ReusePlan {
  const cache = planCache(
    input.epochs,
    storeClobberValues(input.exits)
  );
  const captures = planCaptures({
    uses: input.uses,
    cache,
    loadResults: input.loadResults,
    exits: input.exits
  });

  return {
    cache,
    captures
  };
}

export function planReuseForInstructions(
  instructions: readonly InstructionEpochInput[],
  valueUses: readonly ValueUse[],
  exits: readonly PlannedExit[]
): InstructionReusePlan {
  const epoch = buildEpochs(instructions, valueUses);
  const reuse = planReuse({
    uses: valueUses,
    epochs: epoch.epochs,
    loadResults: epoch.loadResults,
    exits
  });

  return {
    instructions: epoch.instructions,
    ...reuse
  };
}
