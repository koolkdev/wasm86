import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type {
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { CachePlan } from "./cache.js";
import {
  pathsEqual,
  rootPath,
  type Path
} from "#backends/wasm/jit/analysis/paths.js";
import type { PlacedMemoryLoadValue } from "./epochs.js";
import type { PlannedExit } from "./types.js";
import type {
  ValueUse
} from "./value-uses.js";
import type { Placement } from "./schedule-types.js";
import {
  storeClobberSourceStores
} from "./store-strategy.js";

export type CaptureReason =
  | "branchShared"
  | "memoryLoadValue"
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

export type CapturePlan = Readonly<{
  captures: readonly Capture[];
  runtimeCaptures: CaptureMap;
}>;

export type CaptureInput = Readonly<{
  uses: readonly ValueUse[];
  cache: CachePlan;
  memoryLoadValues: readonly PlacedMemoryLoadValue[];
  exits: readonly PlannedExit[];
}>;

export function planCaptures(
  input: CaptureInput
): CapturePlan {
  const memoryLoadValueCaptures = planMemoryLoadValueCaptures(input);
  const rootConsumerCaptures = planRootConsumerCaptures(input.uses, input.cache);
  const storeClobberCaptures = planStoreClobberCaptures(input);
  const selectedExitStoreCaptures = planSelectedExitStoreCaptures(input, [
    ...memoryLoadValueCaptures,
    ...rootConsumerCaptures,
    ...storeClobberCaptures
  ]);
  const captures = uniqueCaptures([
    ...memoryLoadValueCaptures,
    ...rootConsumerCaptures,
    ...selectedExitStoreCaptures,
    ...storeClobberCaptures
  ]);

  return {
    captures,
    runtimeCaptures: capturesByPlacement(captures.filter(isRuntimeCapture))
  };
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
        simplifyValue(selected.value).kind === "loadResult" ||
        valueHasLoadResultDescendant(selected.value, uses)
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

function planMemoryLoadValueCaptures(input: CaptureInput): readonly Capture[] {
  return input.cache.selected.flatMap((selected) => {
    const value = simplifyValue(selected.value);

    if (value.kind !== "loadResult") {
      return [];
    }

    const memoryLoadValue = memoryLoadValueForResult(value, input.memoryLoadValues);
    const consumers = consumersForValue(input.uses, value);

    if (memoryLoadValue === undefined || consumers.length === 0) {
      return [];
    }

    return [{
      value,
      at: memoryLoadValue.at,
      availability: rootPath(),
      consumers,
      reason: "memoryLoadValue"
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

    if (value.kind === "loadResult") {
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

function memoryLoadValueForResult(
  value: JitLoadResultValue,
  memoryLoadValues: readonly PlacedMemoryLoadValue[]
): PlacedMemoryLoadValue | undefined {
  return memoryLoadValues.find((memoryLoadValue) => valuesEqual(memoryLoadValue.value, value));
}

function consumersForValue(
  uses: readonly ValueUse[],
  value: JitValue
): readonly ValueUse[] {
  return uses.filter((use) => valuesEqual(use.value, value));
}

function valueHasLoadResultDescendant(
  value: JitValue,
  uses: readonly ValueUse[]
): boolean {
  return uses.some((use) =>
    simplifyValue(use.value).kind === "loadResult" &&
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

function isRuntimeCapture(capture: Capture): boolean {
  switch (capture.reason) {
    case "branchShared":
    case "forced":
      return true;
    case "memoryLoadValue":
    case "storeClobber":
      return false;
  }

  const exhaustive: never = capture.reason;
  return exhaustive;
}

function placementsEqual(
  left: Placement,
  right: Placement
): boolean {
  return left.opIndex === right.opIndex &&
    left.epoch === right.epoch;
}

function capturesByPlacement(captures: readonly Capture[]): CaptureMap {
  const placementCaptures = new Map<string, Capture[]>();

  for (const capture of captures) {
    const key = placementKey(capture.at);
    const existing = placementCaptures.get(key) ?? [];

    placementCaptures.set(key, [...existing, capture]);
  }

  return placementCaptures;
}

function placementKey(placement: Placement): string {
  return `${placement.opIndex}:${placement.epoch}`;
}
