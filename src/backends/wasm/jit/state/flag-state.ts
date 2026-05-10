import {
  conditionFlagReadMask,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS
} from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS, flagProducerInputsFromRecord } from "#x86/ir/model/flags.js";
import { flagProducerConditionKind } from "#x86/ir/model/flag-conditions.js";
import type { ConditionCode, IrFlagSetOp, ValueRef } from "#x86/ir/model/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import {
  emitFlagsConditionFromAluFlagsValue,
  emitFlagProducerConditionFromInputs
} from "#backends/wasm/codegen/conditions.js";
import { emitFlagProducerBitsFromInputs, type WasmFlagValueEmitHelpers } from "#backends/wasm/codegen/flags.js";
import type { WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import {
  constValueWidth,
  emitMaskValueToWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";
import type {
  JitCachedValueHandle,
  JitValueCacheRuntime
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";

type PendingFlags = Readonly<{
  producer: IrFlagSetOp["producer"];
  width?: IrFlagSetOp["width"];
  writtenMask: IrFlagSetOp["writtenMask"];
  undefMask: IrFlagSetOp["undefMask"];
  inputs: ReadonlyMap<string, PendingInput>;
}>;

type PendingInput =
  | Readonly<{ kind: "local"; local: number; valueWidth: ValueWidth; handle?: JitCachedValueHandle | undefined }>
  | Readonly<{ kind: "value"; value: ValueRef }>;

// Each compact aluFlags bit can come from a different source after partial writes:
// memory on entry or a still-lazy producer descriptor.
type FlagSource =
  | Readonly<{ kind: "incoming" }>
  | Readonly<{ kind: "pending"; pending: PendingFlags }>;

type JitFlagStateOptions = Readonly<{
  emitLoadAluFlagsValue(): void;
  emitStoreAluFlags(emitValue: () => void): void;
  valueCache?: JitValueCacheRuntime | undefined;
}>;

export type JitFlagState = Readonly<{
  emitSet(descriptor: IrFlagSetOp, helpers: WasmIrEmitHelpers): void;
  emitFlagsCondition(cc: ConditionCode): void;
  captureExitStoreSnapshot(mask: number): JitFlagExitStoreSnapshot | undefined;
  emitExitSnapshotStore(snapshot: JitFlagExitStoreSnapshot): void;
  releaseExitSnapshot(snapshot: JitFlagExitStoreSnapshot): void;
  releasePendingOwners(): void;
  assertPendingCoveredBy(mask: number): void;
  assertNoPending(): void;
}>;

export type JitFlagExitStoreSnapshot = Readonly<{
  mask: number;
  source: JitFlagExitStoreSnapshotSource;
  owners: readonly JitCachedValueHandle[];
}>;

type JitFlagExitStoreSnapshotSource =
  | JitFlagIncomingSnapshotSource
  | Readonly<{ kind: "pending"; pending: PendingFlags }>
  | Readonly<{ kind: "merge"; parts: readonly JitFlagMergePart[] }>;

type JitFlagIncomingSnapshotSource = Readonly<{
  kind: "incoming";
}>;

type JitFlagMergePart =
  | Readonly<{ kind: "incoming"; mask: number }>
  | Readonly<{ kind: "pending"; pending: PendingFlags; mask: number }>;

export function createJitFlagState(
  body: WasmFunctionBodyEncoder,
  options: JitFlagStateOptions
): JitFlagState {
  // Keyed by one-bit IR_ALU_FLAG_MASKS values, not by x86 EFLAGS bit positions.
  const flagSources = new Map<number, FlagSource>(
    aluFlagMasks.map((mask) => [mask, incomingFlagSource])
  );
  const releasedPendingFlags = new WeakSet<PendingFlags>();

  return {
    emitSet: (descriptor, helpers) => {
      const pendingInputs = new Map<string, PendingInput>();

      for (const inputName of FLAG_PRODUCERS[descriptor.producer].inputs) {
        const input = descriptor.inputs[inputName];

        if (input === undefined) {
          throw new Error(`missing flag input '${inputName}' for ${descriptor.producer}`);
        }

        if (canKeepPendingInputDirect(input)) {
          pendingInputs.set(inputName, { kind: "value", value: input });
          continue;
        }

        const cachedInput = cachedPendingInput(input, helpers);

        if (cachedInput !== undefined) {
          pendingInputs.set(inputName, cachedInput);
          continue;
        }

        // A pending producer may outlive later flag producers. Allocate fresh
        // captured inputs so ADD.CF can survive a later INC, for example.
        const local = localForInput();
        const valueWidth = helpers.emitValue(input);

        body.localSet(local);
        pendingInputs.set(inputName, { kind: "local", local, valueWidth });
      }

      const pendingFlags = {
        producer: descriptor.producer,
        ...(descriptor.width === undefined ? {} : { width: descriptor.width }),
        writtenMask: descriptor.writtenMask,
        undefMask: descriptor.undefMask,
        inputs: pendingInputs
      };
      const writtenMask = descriptor.writtenMask | descriptor.undefMask;

      setSource(writtenMask, { kind: "pending", pending: pendingFlags });
    },
    emitFlagsCondition: (cc) => {
      const pendingFlags = pendingFlagConditionSource(cc);

      if (pendingFlags !== undefined) {
        emitPendingFlagCondition(pendingFlags, cc);
        return;
      }

      emitFlagsConditionFromAluFlagsValue(body, cc, emitFlagBits);
    },
    captureExitStoreSnapshot: (mask) => {
      const snapshotMask = mask & IR_ALU_FLAG_MASK;

      if (snapshotMask === 0) {
        return undefined;
      }

      return captureExitStoreSnapshot(snapshotMask);
    },
    emitExitSnapshotStore: (snapshot) => {
      const storeMask = snapshot.mask & IR_ALU_FLAG_MASK;

      if (storeMask === 0) {
        return;
      }

      options.emitStoreAluFlags(() => {
        if (storeMask === IR_ALU_FLAG_MASK) {
          emitSnapshotSourceValue(snapshot.source, storeMask);
          return;
        }

        emitIncomingAluFlagsValue();
        body.i32Const(i32(IR_ALU_FLAG_MASK & ~storeMask)).i32And();
        emitSnapshotSourceValue(snapshot.source, storeMask);
        body.i32Const(i32(storeMask)).i32And();
        body.i32Or();
      });
    },
    releaseExitSnapshot: (snapshot) => {
      for (const owner of snapshot.owners) {
        owner.release();
      }
    },
    releasePendingOwners: releaseAllPendingFlagInputs,
    assertPendingCoveredBy: (mask) => {
      const uncoveredMask = sourceMask("pending") & ~mask;

      if (uncoveredMask !== 0) {
        throw new Error(`JIT pending flags are not covered by exit snapshot mask: ${uncoveredMask}`);
      }
    },
    assertNoPending
  };

  function localForInput(): number {
    return body.addLocal(wasmValueType.i32);
  }

  function cachedPendingInput(input: ValueRef, helpers: WasmIrEmitHelpers): PendingInput | undefined {
    const jitValue = options.valueCache?.jitValueForValueRef(input);

    if (jitValue === undefined) {
      return undefined;
    }

    const materialized = options.valueCache?.captureJitValueForReuse(jitValue, () =>
      helpers.emitValue(input)
    );

    return materialized === undefined
      ? undefined
      : {
          kind: "local",
          local: materialized.local,
          valueWidth: materialized.valueWidth,
          handle: materialized
        };
  }

  function captureExitStoreSnapshot(mask: number): JitFlagExitStoreSnapshot {
    const owners = [...retainSnapshotPendingOwners(mask)];
    const incomingSource = { kind: "incoming" } as const satisfies JitFlagIncomingSnapshotSource;
    const singleSource = singleSnapshotSource(mask, incomingSource);

    if (singleSource !== undefined) {
      return { mask, source: singleSource, owners };
    }

    return { mask, source: { kind: "merge", parts: mergeParts(mask, incomingSource) }, owners };
  }

  function emitSnapshotSourceValue(source: JitFlagExitStoreSnapshotSource, mask: number): void {
    switch (source.kind) {
      case "incoming":
        emitIncomingSnapshotSourceValue(source);
        return;
      case "merge":
        emitMergeParts(source.parts);
        return;
      case "pending":
        emitPendingFlagsValue(source.pending, mask);
        return;
    }
  }

  function emitIncomingSnapshotSourceValue(_source: JitFlagIncomingSnapshotSource): void {
    emitIncomingAluFlagsValue();
  }

  function emitFlagBits(mask: number): void {
    const flagsMask = mask & IR_ALU_FLAG_MASK;

    if (flagsMask === 0) {
      body.i32Const(0);
      return;
    }

    const singleSource = singleSnapshotSource(flagsMask, { kind: "incoming" });

    if (singleSource !== undefined) {
      emitSnapshotSourceValue(singleSource, flagsMask);
      return;
    }

    emitMergeParts(mergeParts(flagsMask, { kind: "incoming" }));
  }

  function mergeParts(
    mask: number,
    incomingSource: JitFlagIncomingSnapshotSource
  ): readonly JitFlagMergePart[] {
    const parts: JitFlagMergePart[] = [];
    const incomingMask = sourceMask("incoming") & mask;

    if (incomingMask !== 0) {
      parts.push({ ...incomingSource, mask: incomingMask });
    }

    for (const [pendingFlags, pendingMask] of pendingMasks(mask)) {
      parts.push({ kind: "pending", pending: pendingFlags, mask: pendingMask });
    }

    return parts;
  }

  function emitMergeParts(parts: readonly JitFlagMergePart[]): void {
    if (parts.length === 0) {
      body.i32Const(0);
      return;
    }

    let emitted = false;

    for (const part of parts) {
      emitMergePart(part);

      if (emitted) {
        body.i32Or();
      } else {
        emitted = true;
      }
    }
  }

  function emitMergePart(part: JitFlagMergePart): void {
    switch (part.kind) {
      case "incoming":
        emitIncomingSnapshotSourceValue(part);
        body.i32Const(i32(part.mask));
        body.i32And();
        return;
      case "pending":
        emitPendingFlagsValue(part.pending, part.mask);
        return;
    }
  }

  function singleSnapshotSource(
    mask: number,
    incomingSource: JitFlagIncomingSnapshotSource
  ): JitFlagExitStoreSnapshotSource | undefined {
    let source: FlagSource | undefined;

    for (const flagMask of aluFlagMasks) {
      if ((mask & flagMask) === 0) {
        continue;
      }

      const flagSource = requiredSource(flagMask);

      if (source === undefined) {
        source = flagSource;
      } else if (!sameFlagSource(source, flagSource)) {
        return undefined;
      }
    }

    if (source === undefined) {
      return undefined;
    }

    switch (source.kind) {
      case "incoming":
        return incomingSource;
      case "pending":
        return { kind: "pending", pending: source.pending };
    }
  }

  function assertNoPending(): void {
    if (sourceMask("pending") !== 0) {
      throw new Error("JIT pending flags must be covered by an exit snapshot or released explicitly");
    }
  }

  function emitPendingFlagsValue(pendingFlags: PendingFlags, mask: number): void {
    emitFlagProducerBitsFromInputs(
      body,
      {
        producer: pendingFlags.producer,
        ...(pendingFlags.width === undefined ? {} : { width: pendingFlags.width }),
        inputs: pendingFlagProducerInputs(pendingFlags)
      },
      pendingInputHelpers(),
      mask
    );
  }

  function emitIncomingAluFlagsValue(): void {
    options.emitLoadAluFlagsValue();
  }

  function emitPendingFlagCondition(pendingFlags: PendingFlags, cc: ConditionCode): void {
    emitFlagProducerConditionFromInputs(
      body,
      {
        cc,
        producer: pendingFlags.producer,
        ...(pendingFlags.width === undefined ? {} : { width: pendingFlags.width }),
        inputs: pendingFlagProducerInputs(pendingFlags)
      },
      pendingInputHelpers()
    );
  }

  function pendingFlagProducerInputs(pendingFlags: PendingFlags) {
    const inputRecord: Record<string, PendingInput> = {};

    for (const inputName of FLAG_PRODUCERS[pendingFlags.producer].inputs) {
      const input = pendingFlags.inputs.get(inputName);

      if (input === undefined) {
        throw new Error(`missing pending flag input '${inputName}' for ${pendingFlags.producer}`);
      }

      inputRecord[inputName] = input;
    }

    return flagProducerInputsFromRecord(pendingFlags.producer, inputRecord);
  }

  function pendingInputHelpers(): WasmFlagValueEmitHelpers<PendingInput> {
    return {
      emitValue: emitPendingInputValue,
      emitMaskedValue: (input, width) => emitMaskValueToWidth(body, width, emitPendingInputValue(input))
    };
  }

  function emitPendingInputValue(input: PendingInput): ValueWidth {
    switch (input.kind) {
      case "local":
        body.localGet(input.local);
        return input.valueWidth;
      case "value":
        return emitDirectPendingInput(input.value);
    }
  }

  function emitDirectPendingInput(value: ValueRef): ValueWidth {
    switch (value.kind) {
      case "const":
        body.i32Const(i32(value.value));
        return constValueWidth(value.value);
      case "nextEip":
        throw new Error("nextEip is not a valid pending flag input");
      default:
        throw new Error(`unsupported direct pending flag input: ${value.kind}`);
    }
  }

  function pendingFlagConditionSource(cc: ConditionCode): PendingFlags | undefined {
    let pendingFlags: PendingFlags | undefined;

    for (const flagMask of aluFlagMasks) {
      if ((conditionFlagReadMask(cc) & flagMask) === 0) {
        continue;
      }

      const source = requiredSource(flagMask);

      if (source.kind !== "pending") {
        return undefined;
      }

      if (pendingFlags === undefined) {
        pendingFlags = source.pending;
      } else if (pendingFlags !== source.pending) {
        return undefined;
      }
    }

    if (
      pendingFlags === undefined ||
      flagProducerConditionKind({ producer: pendingFlags.producer, width: pendingFlags.width, cc }) === undefined
    ) {
      return undefined;
    }

    return pendingFlags;
  }

  function sourceMask(kind: FlagSource["kind"]): number {
    let mask = 0;

    for (const flagMask of aluFlagMasks) {
      if (requiredSource(flagMask).kind === kind) {
        mask |= flagMask;
      }
    }

    return mask;
  }

  function setSource(mask: number, source: FlagSource): void {
    const replacedPending = new Set<PendingFlags>();

    for (const flagMask of aluFlagMasks) {
      if ((mask & flagMask) !== 0) {
        const previous = requiredSource(flagMask);

        if (
          previous.kind === "pending" &&
          (source.kind !== "pending" || previous.pending !== source.pending)
        ) {
          replacedPending.add(previous.pending);
        }

        flagSources.set(flagMask, source);
      }
    }

    for (const pendingFlags of replacedPending) {
      releasePendingFlagsIfUnreferenced(pendingFlags);
    }
  }

  function releasePendingFlagsIfUnreferenced(pendingFlags: PendingFlags): void {
    if (releasedPendingFlags.has(pendingFlags)) {
      return;
    }

    for (const flagMask of aluFlagMasks) {
      const source = requiredSource(flagMask);

      if (source.kind === "pending" && source.pending === pendingFlags) {
        return;
      }
    }

    releasedPendingFlags.add(pendingFlags);
    releasePendingFlagInputs(pendingFlags);
  }

  function releasePendingFlagInputs(pendingFlags: PendingFlags): void {
    for (const input of pendingFlags.inputs.values()) {
      if (input.kind === "local") {
        input.handle?.release();
      }
    }
  }

  function retainSnapshotPendingOwners(mask: number): readonly JitCachedValueHandle[] {
    const owners: JitCachedValueHandle[] = [];

    for (const pendingFlags of pendingMasks(mask).keys()) {
      for (const input of pendingFlags.inputs.values()) {
        if (input.kind === "local" && input.handle !== undefined) {
          owners.push(input.handle.retain());
        }
      }
    }

    return owners;
  }

  function releaseAllPendingFlagInputs(): void {
    const pendingFlags = new Set<PendingFlags>();

    for (const source of flagSources.values()) {
      if (source.kind === "pending") {
        pendingFlags.add(source.pending);
      }
    }

    for (const pending of pendingFlags) {
      if (!releasedPendingFlags.has(pending)) {
        releasedPendingFlags.add(pending);
        releasePendingFlagInputs(pending);
      }
    }
  }

  function pendingMasks(mask: number): ReadonlyMap<PendingFlags, number> {
    const groups = new Map<PendingFlags, number>();

    for (const flagMask of aluFlagMasks) {
      if ((mask & flagMask) === 0) {
        continue;
      }

      const source = requiredSource(flagMask);

      if (source.kind !== "pending") {
        continue;
      }

      groups.set(source.pending, (groups.get(source.pending) ?? 0) | flagMask);
    }

    return groups;
  }

  function requiredSource(flagMask: number): FlagSource {
    const source = flagSources.get(flagMask);

    if (source === undefined) {
      throw new Error(`missing JIT flag source for mask: ${flagMask}`);
    }

    return source;
  }
}

function canKeepPendingInputDirect(input: ValueRef): boolean {
  return input.kind === "const";
}

const aluFlagMasks = Object.values(IR_ALU_FLAG_MASKS);
const incomingFlagSource = { kind: "incoming" } as const satisfies FlagSource;

function sameFlagSource(left: FlagSource, right: FlagSource): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return left.kind !== "pending" || right.kind !== "pending" || left.pending === right.pending;
}
