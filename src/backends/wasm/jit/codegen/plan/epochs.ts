import type {
  IrExprBlock,
} from "#backends/wasm/codegen/expressions.js";
import type {
  LoadResultDefinition,
  Timeline
} from "#backends/wasm/jit/analysis/timeline-types.js";
import type {
  ValueUse
} from "./value-uses.js";
import type { Placement } from "./effect-types.js";

export type InstructionEpochSource = Readonly<{
  valueTimeline: Timeline;
}>;

export type InstructionEpochs = InstructionEpochSource & Readonly<{
  opEpochs: readonly number[];
}>;

export type InstructionEpochInput = InstructionEpochSource & Readonly<{
  expressionBlock: IrExprBlock;
}>;

export type EpochUsePlan = Readonly<{
  index: number;
  uses: readonly ValueUse[];
}>;

export type PlacedLoadResultDefinition = LoadResultDefinition & Readonly<{
  at: Placement;
}>;

export type EpochBuildPlan = Readonly<{
  instructions: readonly InstructionEpochs[];
  epochs: readonly EpochUsePlan[];
  loadResults: readonly PlacedLoadResultDefinition[];
}>;

export function buildEpochs(
  instructions: readonly InstructionEpochInput[],
  valueUses: readonly ValueUse[]
): EpochBuildPlan {
  const instructionPlans: InstructionEpochs[] = [];
  const loadResults: PlacedLoadResultDefinition[] = [];
  let currentEpoch = 0;

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex]!;
    const opEpochs: number[] = [];
    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.writes.map((write) => write.opIndex)
    );

    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
      }

      opEpochs[opIndex] = currentEpoch;

      if (writeExpressionOpIndexes.has(opIndex)) {
        currentEpoch += 1;
      }
    }

    for (const definition of instruction.valueTimeline.loadResults) {
      const epoch = opEpochs[definition.opIndex];

      if (epoch === undefined) {
        throw new Error(`missing JIT load-result definition epoch: ${definition.opIndex}`);
      }

      loadResults.push({
        ...definition,
        at: {
          instructionIndex,
          opIndex: definition.opIndex,
          epoch
        }
      });
    }

    instructionPlans.push({
      valueTimeline: instruction.valueTimeline,
      opEpochs
    });
  }

  const epochCount = currentEpoch + 1;

  return {
    instructions: instructionPlans,
    epochs: consumerUses(valueUses, epochCount).map((uses, index) => ({
      index,
      uses
    })),
    loadResults
  };
}

export function jitExpressionOpEpochs(
  instruction: Pick<InstructionEpochInput, "expressionBlock" | "valueTimeline">,
  startEpoch = 0
): readonly number[] {
  const opEpochs: number[] = [];
  const writeExpressionOpIndexes = new Set(
    instruction.valueTimeline.writes.map((write) => write.opIndex)
  );
  let currentEpoch = startEpoch;

  for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
    const op = instruction.expressionBlock[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT value-cache expression op: ${opIndex}`);
    }

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
