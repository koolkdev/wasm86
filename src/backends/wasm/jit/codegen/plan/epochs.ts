import type { BlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type {
  MemoryLoadValue,
  Timeline
} from "#backends/wasm/jit/analysis/timeline-types.js";
import type {
  ValueUse
} from "./value-uses.js";
import type { Placement } from "./schedule-types.js";

export type BlockEpochSource = Readonly<{
  valueTimeline: Timeline;
}>;

export type BlockEpochs = BlockEpochSource & Readonly<{
  opEpochs: readonly number[];
}>;

export type BlockEpochInput = BlockEpochSource & Readonly<{
  expressions: BlockExpressions;
}>;

export type EpochUsePlan = Readonly<{
  index: number;
  uses: readonly ValueUse[];
}>;

export type PlacedMemoryLoadValue = MemoryLoadValue & Readonly<{
  at: Placement;
}>;

export type EpochBuildPlan = Readonly<{
  block: BlockEpochs;
  epochs: readonly EpochUsePlan[];
  memoryLoadValues: readonly PlacedMemoryLoadValue[];
}>;

export function buildEpochs(
  block: BlockEpochInput,
  valueUses: readonly ValueUse[]
): EpochBuildPlan {
  const memoryLoadValues: PlacedMemoryLoadValue[] = [];
  let currentEpoch = 0;
  const opEpochs: number[] = [];
  const writeExpressionOpIndexes = new Set(
    block.valueTimeline.writes.map((write) => write.opIndex)
  );

  for (const entry of block.expressions.ops) {
    const opIndex = entry.opIndex;

    opEpochs[opIndex] = currentEpoch;

    if (writeExpressionOpIndexes.has(opIndex)) {
      currentEpoch += 1;
    }
  }

  for (const memoryLoadValue of block.valueTimeline.memoryLoadValues) {
    const epoch = opEpochs[memoryLoadValue.opIndex];

    if (epoch === undefined) {
      throw new Error(`missing JIT memory-load value epoch: ${memoryLoadValue.opIndex}`);
    }

    memoryLoadValues.push({
      ...memoryLoadValue,
      at: {
        opIndex: memoryLoadValue.opIndex,
        epoch
      }
    });
  }

  const epochCount = currentEpoch + 1;

  return {
    block: {
      valueTimeline: block.valueTimeline,
      opEpochs
    },
    epochs: consumerUses(valueUses, epochCount).map((uses, index) => ({
      index,
      uses
    })),
    memoryLoadValues
  };
}

export function jitExpressionOpEpochs(
  block: Pick<BlockEpochInput, "expressions" | "valueTimeline">,
  startEpoch = 0
): readonly number[] {
  const opEpochs: number[] = [];
  const writeExpressionOpIndexes = new Set(
    block.valueTimeline.writes.map((write) => write.opIndex)
  );
  let currentEpoch = startEpoch;

  for (const entry of block.expressions.ops) {
    const opIndex = entry.opIndex;

    opEpochs[opIndex] = currentEpoch;

    if (writeExpressionOpIndexes.has(opIndex)) {
      currentEpoch += 1;
    }
  }

  return opEpochs;
}

function consumerUses(
  valueUses: readonly ValueUse[],
  epochCount: number
): readonly (readonly ValueUse[])[] {
  const epochUses: ValueUse[][] = Array.from(
    { length: epochCount },
    () => []
  );

  for (const use of valueUses) {
    const uses = epochUses[use.at.epoch];

    if (uses === undefined) {
      throw new Error(`JIT value use references missing epoch: ${use.at.epoch}`);
    }

    uses.push(use);
  }

  return epochUses;
}
