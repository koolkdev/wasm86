import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitProducedValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { CachePlan } from "./cache.js";
import {
  pathsEqual,
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import type { PlacedProducedDefinition } from "./epochs.js";
import type { PlannedExit } from "./types.js";
import type {
  Placement,
  ValueUse
} from "./value-uses.js";
import {
  storeClobberSourceStores
} from "./store-strategy.js";

export type CaptureReason =
  | "branchShared"
  | "producedDefinition"
  | "storeClobber"
  | "forced";

export type Capture = Readonly<{
  value: JitValue;
  at: Placement;
  availability: Path;
  consumers: readonly ValueUse[];
  reason: CaptureReason;
}>;

export type CaptureMap = ReadonlyMap<string, readonly Capture[]>;

export type InstructionCaptureMap = ReadonlyMap<
  number,
  readonly Capture[]
>;

export type CapturePlan = Readonly<{
  captures: readonly Capture[];
  byPlacement: CaptureMap;
}>;

export type CaptureInput = Readonly<{
  uses: readonly ValueUse[];
  cache: CachePlan;
  produced: readonly PlacedProducedDefinition[];
  exits: readonly PlannedExit[];
}>;

export function planCaptures(
  input: CaptureInput
): CapturePlan {
  const producedDefinitionCaptures = planProducedDefinitionCaptures(input);
  const rootConsumerCaptures = planRootConsumerCaptures(input.uses, input.cache);
  const storeClobberCaptures = planStoreClobberCaptures(input);
  const captures = uniqueCaptures([
    ...producedDefinitionCaptures,
    ...rootConsumerCaptures,
    ...storeClobberCaptures,
    ...planSelectedExitStoreCaptures(input, [
      ...producedDefinitionCaptures,
      ...rootConsumerCaptures,
      ...storeClobberCaptures
    ])
  ]);

  return {
    captures,
    byPlacement: capturesByPlacement(captures)
  };
}

export function groupCapturesByInstruction(
  captures: readonly Capture[],
  instructionCount: number
): readonly InstructionCaptureMap[] {
  const grouped: Map<number, Capture[]>[] = [];

  for (const capture of captures) {
    if (capture.reason !== "branchShared" && capture.reason !== "forced") {
      continue;
    }

    const instructionCaptures = grouped[capture.at.instructionIndex] ?? new Map();
    const expressionCaptures = instructionCaptures.get(capture.at.opIndex) ?? [];

    instructionCaptures.set(capture.at.opIndex, [...expressionCaptures, capture]);
    grouped[capture.at.instructionIndex] = instructionCaptures;
  }

  return Array.from({ length: instructionCount }, (_entry, index) =>
    grouped[index] ?? new Map()
  );
}

function planRootConsumerCaptures(
  uses: readonly ValueUse[],
  cachePlan: CachePlan
): readonly Capture[] {
  const captures: Capture[] = [];

  for (const epoch of cachePlan.epochs) {
    const epochUses = uses
      .filter((use) => use.at.epoch === epoch.index);

    for (const selected of epoch.consumers) {
      if (
        simplifyValue(selected.value).kind === "produced" ||
        valueHasProducedDescendant(selected.value, uses)
      ) {
        continue;
      }

      const consumers = epochUses
        .filter((use) => valuesEqual(use.value, selected.value));
      const capture = rootCaptureForConsumers(selected.value, consumers);

      if (capture !== undefined) {
        captures.push(capture);
      }
    }
  }

  return uniqueCaptures(captures);
}

function planProducedDefinitionCaptures(input: CaptureInput): readonly Capture[] {
  return input.cache.selected.flatMap((selected) => {
    const value = simplifyValue(selected.value);

    if (value.kind !== "produced") {
      return [];
    }

    const definition = producedDefinitionForValue(value, input.produced);
    const consumers = consumersForValue(input.uses, value);

    if (definition === undefined || consumers.length === 0) {
      return [];
    }

    return [{
      value,
      at: definition.at,
      availability: rootPath(),
      consumers,
      reason: "producedDefinition"
    }];
  });
}

function rootCaptureForConsumers(
  value: JitValue,
  consumers: readonly ValueUse[]
): Capture | undefined {
  if (consumers.length === 0) {
    return undefined;
  }

  const placement = consumers[0]?.at;

  if (
    placement === undefined ||
    !consumers.every((consumer) => placementsEqual(consumer.at, placement))
  ) {
    return undefined;
  }

  const pathIds = new Set(consumers.map((consumer) => consumer.path.id));

  if (pathIds.size < 2) {
    return undefined;
  }

  return {
    value,
    at: placement,
    availability: rootPath(),
    consumers,
    reason: "branchShared"
  };
}

function planStoreClobberCaptures(input: CaptureInput): readonly Capture[] {
  return input.exits.flatMap((exit) =>
    storeClobberSourceStores(exit).flatMap((store) => {
      const value = simplifyValue(store.value);
      const consumers = input.uses.filter((use) =>
        use.purpose === "exitStore" &&
          use.exitId === exit.id &&
          valuesEqual(use.value, value)
      );
      const firstConsumer = consumers[0];

      if (firstConsumer === undefined) {
        return [];
      }

      return [{
        value,
        at: firstConsumer.at,
        availability: firstConsumer.path,
        consumers,
        reason: "storeClobber" as const
      }];
    })
  );
}

function planSelectedExitStoreCaptures(
  input: CaptureInput,
  existingCaptures: readonly Capture[]
): readonly Capture[] {
  const captures: Capture[] = [];

  for (const selected of input.cache.selected) {
    const value = simplifyValue(selected.value);

    if (value.kind === "produced") {
      continue;
    }

    const consumers = consumersForValue(input.uses, value)
      .filter((use) => use.purpose === "exitStore");

    for (const consumer of consumers) {
      if (captureExists(existingCaptures, value, consumer.at, consumer.path)) {
        continue;
      }

      captures.push({
        value,
        at: consumer.at,
        availability: consumer.path,
        consumers: [consumer],
        reason: "forced"
      });
    }
  }

  return captures;
}

function captureExists(
  captures: readonly Capture[],
  value: JitValue,
  placement: Placement,
  path: Path
): boolean {
  return captures.some((capture) =>
    valuesEqual(capture.value, value) &&
      placementsEqual(capture.at, placement) &&
      captureAvailabilityCoversPath(capture.availability, path)
  );
}

function captureAvailabilityCoversPath(availability: Path, path: Path): boolean {
  return pathsEqual(availability, path) || pathsEqual(availability, rootPath());
}

function producedDefinitionForValue(
  value: JitProducedValue,
  definitions: readonly PlacedProducedDefinition[]
): PlacedProducedDefinition | undefined {
  return definitions.find((definition) => valuesEqual(definition.value, value));
}

function consumersForValue(
  uses: readonly ValueUse[],
  value: JitValue
): readonly ValueUse[] {
  return uses.filter((use) => valuesEqual(use.value, value));
}

function valueHasProducedDescendant(
  value: JitValue,
  uses: readonly ValueUse[]
): boolean {
  return uses.some((use) =>
    simplifyValue(use.value).kind === "produced" &&
      use.ancestors.some((ancestor) => valuesEqual(ancestor, value))
  );
}

function uniqueCaptures(
  captures: readonly Capture[]
): readonly Capture[] {
  const unique: Capture[] = [];

  for (const capture of captures) {
    if (!unique.some((entry) =>
      valuesEqual(entry.value, capture.value) &&
        placementsEqual(entry.at, capture.at) &&
        pathsEqual(entry.availability, capture.availability) &&
        entry.reason === capture.reason
    )) {
      unique.push(capture);
    }
  }

  return unique;
}

function placementsEqual(
  left: Placement,
  right: Placement
): boolean {
  return left.instructionIndex === right.instructionIndex &&
    left.opIndex === right.opIndex &&
    left.epoch === right.epoch;
}

function capturesByPlacement(captures: readonly Capture[]): CaptureMap {
  const byPlacement = new Map<string, Capture[]>();

  for (const capture of captures) {
    const key = placementKey(capture.at);
    const existing = byPlacement.get(key) ?? [];

    byPlacement.set(key, [...existing, capture]);
  }

  return byPlacement;
}

function placementKey(placement: Placement): string {
  return `${placement.instructionIndex}:${placement.opIndex}:${placement.epoch}`;
}
