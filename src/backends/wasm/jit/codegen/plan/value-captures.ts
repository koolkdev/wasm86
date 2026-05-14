import {
  jitValueDependencies,
  jitValuesEqual,
  simplifyJitValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import type { JitExpressionValueCachePlan } from "./value-cache.js";
import {
  jitValuePathScopesEqual,
  rootValuePathScope,
  type JitValuePathScope
} from "./control-paths.js";
import type {
  JitPlannedValueUse,
  JitValueUsePlacement
} from "./value-uses.js";

export type JitPlannedValueCapture = Readonly<{
  value: JitValue;
  placement: JitValueUsePlacement;
  availabilityScope: JitValuePathScope;
  consumers: readonly JitPlannedValueUse[];
}>;

export type JitPlannedValueCapturesByExpression = ReadonlyMap<
  number,
  readonly JitPlannedValueCapture[]
>;

export function planJitValueCaptures(
  uses: readonly JitPlannedValueUse[],
  cachePlan: JitExpressionValueCachePlan | undefined
): readonly JitPlannedValueCapture[] {
  if (cachePlan === undefined) {
    return [];
  }

  return planRootConsumerCaptures(uses, cachePlan);
}

export function groupJitPlannedCapturesByInstructionExpression(
  captures: readonly JitPlannedValueCapture[],
  instructionCount: number
): readonly JitPlannedValueCapturesByExpression[] {
  const grouped: Map<number, JitPlannedValueCapture[]>[] = [];

  for (const capture of captures) {
    const instructionCaptures = grouped[capture.placement.instructionIndex] ?? new Map();
    const expressionCaptures = instructionCaptures.get(capture.placement.opIndex) ?? [];

    instructionCaptures.set(capture.placement.opIndex, [...expressionCaptures, capture]);
    grouped[capture.placement.instructionIndex] = instructionCaptures;
  }

  return Array.from({ length: instructionCount }, (_entry, index) =>
    grouped[index] ?? new Map()
  );
}

function planRootConsumerCaptures(
  uses: readonly JitPlannedValueUse[],
  cachePlan: JitExpressionValueCachePlan
): readonly JitPlannedValueCapture[] {
  const captures: JitPlannedValueCapture[] = [];

  for (let epoch = 0; epoch < cachePlan.selectedConsumerValuesByEpoch.length; epoch += 1) {
    const epochUses = uses.filter((use) => use.placement.epoch === epoch);

    for (const selected of cachePlan.selectedConsumerValuesByEpoch[epoch] ?? []) {
      if (
        simplifyJitValue(selected.value).kind === "produced" ||
        jitValueDependsOnProduced(selected.value)
      ) {
        continue;
      }

      const consumers = epochUses.filter((use) => jitValuesEqual(use.value, selected.value));
      const capture = rootCaptureForConsumers(selected.value, consumers);

      if (capture !== undefined) {
        captures.push(capture);
      }
    }
  }

  return uniqueCaptures(captures);
}

function jitValueDependsOnProduced(value: JitValue): boolean {
  return jitValueDependencies(simplifyJitValue(value)).some((dependency) => {
    const simplified = simplifyJitValue(dependency);

    return simplified.kind === "produced" || jitValueDependsOnProduced(simplified);
  });
}

function rootCaptureForConsumers(
  value: JitValue,
  consumers: readonly JitPlannedValueUse[]
): JitPlannedValueCapture | undefined {
  if (consumers.length === 0) {
    return undefined;
  }

  const placement = consumers[0]?.placement;

  if (
    placement === undefined ||
    !consumers.every((consumer) => placementsEqual(consumer.placement, placement))
  ) {
    return undefined;
  }

  const pathIds = new Set(consumers.map((consumer) => consumer.pathScope.id));

  if (pathIds.size < 2) {
    return undefined;
  }

  return {
    value,
    placement,
    availabilityScope: rootValuePathScope(),
    consumers
  };
}

function uniqueCaptures(
  captures: readonly JitPlannedValueCapture[]
): readonly JitPlannedValueCapture[] {
  const unique: JitPlannedValueCapture[] = [];

  for (const capture of captures) {
    if (!unique.some((entry) =>
      jitValuesEqual(entry.value, capture.value) &&
        placementsEqual(entry.placement, capture.placement) &&
        jitValuePathScopesEqual(entry.availabilityScope, capture.availabilityScope)
    )) {
      unique.push(capture);
    }
  }

  return unique;
}

function placementsEqual(
  left: JitValueUsePlacement,
  right: JitValueUsePlacement
): boolean {
  return left.instructionIndex === right.instructionIndex &&
    left.opIndex === right.opIndex &&
    left.epoch === right.epoch;
}
