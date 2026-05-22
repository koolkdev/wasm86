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
  type BlockEpochInput,
  type BlockEpochs,
  type EpochUsePlan,
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
  CaptureReason
} from "./captures.js";
export type {
  BlockEpochSource,
  BlockEpochs,
  BlockEpochInput,
  EpochUsePlan,
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

export type BlockReusePlan = ReusePlan & Readonly<{
  block: BlockEpochs;
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

export function planReuseForBlock(
  block: BlockEpochInput,
  valueUses: readonly ValueUse[],
  exits: readonly PlannedExit[]
): BlockReusePlan {
  const epoch = buildEpochs(block, valueUses);
  const reuse = planReuse({
    uses: valueUses,
    epochs: epoch.epochs,
    loadResults: epoch.loadResults,
    exits
  });

  return {
    block: epoch.block,
    ...reuse
  };
}
