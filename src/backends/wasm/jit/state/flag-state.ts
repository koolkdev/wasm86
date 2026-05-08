import {
  conditionFlagReadMask,
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS
} from "#x86/ir/model/flag-effects.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import {
  flagProducerConditionInputNames,
  flagProducerConditionKind
} from "#x86/ir/model/flag-conditions.js";
import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { ConditionCode, IrFlagSetOp, ValueRef } from "#x86/ir/model/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import {
  emitAluFlagsCondition,
  emitFlagProducerCondition
} from "#backends/wasm/codegen/conditions.js";
import {
  wasmIrLocalAluFlagsStorage
} from "#backends/wasm/codegen/alu-flags.js";
import { emitSetFlags } from "#backends/wasm/codegen/flags.js";
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

type PendingInputRefs = Readonly<{
  inputRefs: Readonly<Record<string, ValueRef>>;
  inputsByVarId: ReadonlyMap<number, PendingInput>;
}>;

// Each compact aluFlags bit can come from a different place after partial writes:
// memory on entry, the cached local, or a still-lazy producer descriptor.
type FlagSource =
  | Readonly<{ kind: "incoming" }>
  | Readonly<{ kind: "local" }>
  | Readonly<{ kind: "pending"; pending: PendingFlags }>;

type JitFlagStateOptions = Readonly<{
  emitLoadAluFlags(): void;
  emitLoadAluFlagsValue(): void;
  emitStoreAluFlags(emitValue: () => void): void;
  valueCache?: JitValueCacheRuntime | undefined;
}>;

type JitFlagExitStoreSnapshotOptions = Readonly<{
  consume?: boolean;
}>;

export type JitFlagState = Readonly<{
  emitSet(descriptor: IrFlagSetOp, helpers: WasmIrEmitHelpers): void;
  emitMaterialize(mask: number): void;
  emitBoundary(mask: number): void;
  emitAluFlagsCondition(cc: ConditionCode): void;
  captureExitStoreSnapshot(
    mask: number,
    options?: JitFlagExitStoreSnapshotOptions
  ): JitFlagExitStoreSnapshot | undefined;
  emitExitSnapshotStore(snapshot: JitFlagExitStoreSnapshot): void;
  assertPendingCoveredBy(mask: number): void;
  assertNoPending(): void;
}>;

export type JitFlagExitStoreSnapshot = Readonly<{
  mask: number;
  local: number;
}>;

export function createJitFlagState(
  body: WasmFunctionBodyEncoder,
  aluFlagsLocal: number,
  options: JitFlagStateOptions
): JitFlagState {
  const aluFlags = wasmIrLocalAluFlagsStorage(body, aluFlagsLocal);
  // Keyed by one-bit IR_ALU_FLAG_MASKS values, not by x86 EFLAGS bit positions.
  const flagSources = new Map<number, FlagSource>(
    aluFlagMasks.map((mask) => [mask, incomingFlagSource])
  );
  const releasedPendingFlags = new WeakSet<PendingFlags>();
  let aluFlagsLocalDirty = false;
  let materializedMask = 0;

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
      materializedMask &= ~writtenMask;
    },
    emitMaterialize: (mask) => {
      const missingMask = mask & ~materializedMask;

      if (missingMask === 0) {
        return;
      }

      materializeFlags(missingMask);
    },
    emitBoundary: (mask) => {
      materializePendingFlags(mask & ~materializedMask);

      if (!aluFlagsLocalDirty) {
        return;
      }

      // If local producer bits will be stored, merge any untouched incoming bits
      // first so the store publishes a complete compact aluFlags word.
      materializeFlags(IR_ALU_FLAG_MASK & ~materializedMask);
      options.emitStoreAluFlags(() => {
        body.localGet(aluFlagsLocal);
      });
      aluFlagsLocalDirty = false;
    },
    emitAluFlagsCondition: (cc) => {
      const pendingFlags = pendingFlagConditionSource(cc);

      if (pendingFlags !== undefined) {
        emitPendingFlagCondition(pendingFlags, cc);
        return;
      }

      materializeFlags(conditionFlagReadMask(cc) & ~materializedMask);
      emitAluFlagsCondition(body, aluFlags, cc);
    },
    captureExitStoreSnapshot: (mask, options = {}) => {
      const snapshotMask = mask & IR_ALU_FLAG_MASK;

      if (snapshotMask === 0) {
        return undefined;
      }

      if (options.consume === false) {
        return captureNonConsumingExitStoreSnapshot(snapshotMask);
      }

      materializeFlags(snapshotMask & ~materializedMask);

      const snapshotLocal = body.addLocal(wasmValueType.i32);

      body.localGet(aluFlagsLocal);
      body.localSet(snapshotLocal);
      return { mask: snapshotMask, local: snapshotLocal };
    },
    emitExitSnapshotStore: (snapshot) => {
      const storeMask = snapshot.mask & IR_ALU_FLAG_MASK;

      if (storeMask === 0) {
        return;
      }

      options.emitStoreAluFlags(() => {
        if (storeMask === IR_ALU_FLAG_MASK) {
          body.localGet(snapshot.local);
          return;
        }

        options.emitLoadAluFlagsValue();
        body.i32Const(i32(IR_ALU_FLAG_MASK & ~storeMask)).i32And();
        body.localGet(snapshot.local);
        body.i32Const(i32(storeMask)).i32And();
        body.i32Or();
      });
    },
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

  function captureNonConsumingExitStoreSnapshot(mask: number): JitFlagExitStoreSnapshot {
    const snapshotLocal = body.addLocal(wasmValueType.i32);
    const localMask = sourceMask("local") & mask;
    const incomingMask = sourceMask("incoming") & mask;

    body.i32Const(0);
    body.localSet(snapshotLocal);

    if (localMask !== 0) {
      mergeSnapshotBits(snapshotLocal, localMask, () => {
        body.localGet(aluFlagsLocal);
      });
    }

    if (incomingMask !== 0) {
      mergeSnapshotBits(snapshotLocal, incomingMask, () => {
        options.emitLoadAluFlagsValue();
      });
    }

    for (const [pendingFlags, pendingMask] of pendingMasks(mask)) {
      emitPendingFlags(pendingFlags, pendingMask);
      mergeSnapshotBits(snapshotLocal, pendingMask, () => {
        body.localGet(aluFlagsLocal);
      });
    }

    return { mask, local: snapshotLocal };
  }

  function mergeSnapshotBits(targetLocal: number, mask: number, emitValue: () => void): void {
    body.localGet(targetLocal);
    emitValue();
    body.i32Const(i32(mask));
    body.i32And();
    body.i32Or();
    body.localSet(targetLocal);
  }

  function materializeFlags(mask: number): void {
    if (mask === 0) {
      return;
    }

    const incomingMask = sourceMask("incoming") & mask;

    if (incomingMask !== 0) {
      materializeIncoming(incomingMask);
    }

    materializePendingFlags(mask);
  }

  function materializePendingFlags(mask: number): void {
    for (const [pendingFlags, pendingMask] of pendingMasks(mask)) {
      emitPendingFlags(pendingFlags, pendingMask);
      setSource(pendingMask, localFlagSource);
      materializedMask |= pendingMask;
      aluFlagsLocalDirty = true;
    }
  }

  function materializeIncoming(mask: number): void {
    if (materializedMask === 0) {
      options.emitLoadAluFlags();
    } else {
      // Preserve already-materialized local bits while pulling only the requested
      // incoming bits from state. This is what lets INC publish new ZF/SF/etc.
      // without clobbering incoming CF.
      body.localGet(aluFlagsLocal);
      body.i32Const(i32(IR_ALU_FLAG_MASK & ~mask)).i32And();
      options.emitLoadAluFlagsValue();
      body.i32Const(mask).i32And();
      body.i32Or();
      body.localSet(aluFlagsLocal);
    }

    setSource(mask, localFlagSource);
    materializedMask |= mask;
  }

  function assertNoPending(): void {
    if (sourceMask("pending") !== 0) {
      throw new Error("JIT pending flags must be materialized explicitly");
    }
  }

  function emitPendingFlags(
    pendingFlags: PendingFlags,
    mask: number
  ): void {
    const inputs = pendingInputRefs(pendingFlags, FLAG_PRODUCERS[pendingFlags.producer].inputs);

    emitSetFlags(
      body,
      aluFlags,
      {
        op: "flags.set",
        producer: pendingFlags.producer,
        ...(pendingFlags.width === undefined ? {} : { width: pendingFlags.width }),
        writtenMask: pendingFlags.writtenMask,
        undefMask: pendingFlags.undefMask,
        inputs: inputs.inputRefs
      },
      {
        emitValue: (value) => emitPendingInputValue(inputs.inputsByVarId, value, "pending flag input"),
        emitMaskedValue: (value, width) =>
          emitMaskValueToWidth(body, width, emitPendingInputValue(inputs.inputsByVarId, value, "pending flag input"))
      },
      { mask }
    );
  }

  function emitPendingFlagCondition(pendingFlags: PendingFlags, cc: ConditionCode): void {
    const inputs = pendingInputRefs(
      pendingFlags,
      flagProducerConditionInputNames({ producer: pendingFlags.producer, width: pendingFlags.width, cc })
    );

    emitFlagProducerCondition(
      body,
      {
        kind: "flagProducer.condition",
        cc,
        producer: pendingFlags.producer,
        ...(pendingFlags.width === undefined ? {} : { width: pendingFlags.width }),
        writtenMask: pendingFlags.writtenMask,
        undefMask: pendingFlags.undefMask,
        inputs: inputs.inputRefs
      },
      {
        emitValue: (value) => emitPendingInputValue(inputs.inputsByVarId, value, "pending flag condition input"),
        emitMaskedValue: (value, width) =>
          emitMaskValueToWidth(
            body,
            width,
            emitPendingInputValue(inputs.inputsByVarId, value, "pending flag condition input")
          )
      }
    );
  }

  function pendingInputRefs(pendingFlags: PendingFlags, inputNames: readonly string[]): PendingInputRefs {
    const inputRefs: Record<string, ValueRef> = {};
    const inputsByVarId = new Map<number, PendingInput>();

    for (let index = 0; index < inputNames.length; index += 1) {
      const inputName = inputNames[index]!;
      const input = pendingFlags.inputs.get(inputName);

      if (input === undefined) {
        throw new Error(`missing pending flag input '${inputName}' for ${pendingFlags.producer}`);
      }

      if (input.kind === "value") {
        inputRefs[inputName] = input.value;
      } else {
        inputRefs[inputName] = { kind: "var", id: index };
        inputsByVarId.set(index, input);
      }
    }

    return { inputRefs, inputsByVarId };
  }

  function emitPendingInputValue(
    inputsByVarId: ReadonlyMap<number, PendingInput>,
    value: IrValueExpr,
    context: string
  ): ValueWidth {
    switch (value.kind) {
      case "var": {
        const input = requiredPendingInput(inputsByVarId, value.id);

        switch (input.kind) {
          case "local":
            body.localGet(input.local);
            return input.valueWidth;
          case "value":
            return emitDirectPendingInput(input.value, context);
        }
      }
      case "const":
        body.i32Const(i32(value.value));
        return constValueWidth(value.value);
      case "nextEip":
        throw new Error(`nextEip is not a valid ${context}`);
      default:
        throw new Error(`unsupported ${context}: ${value.kind}`);
    }
  }

  function emitDirectPendingInput(value: ValueRef, context: string): ValueWidth {
    switch (value.kind) {
      case "const":
        body.i32Const(i32(value.value));
        return constValueWidth(value.value);
      case "nextEip":
        throw new Error(`nextEip is not a valid ${context}`);
      default:
        throw new Error(`unsupported direct ${context}: ${value.kind}`);
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

function requiredPendingInput(inputsByVarId: ReadonlyMap<number, PendingInput>, id: number): PendingInput {
  const input = inputsByVarId.get(id);

  if (input === undefined) {
    throw new Error(`missing pending flag input: ${id}`);
  }

  return input;
}

const aluFlagMasks = Object.values(IR_ALU_FLAG_MASKS);
const incomingFlagSource = { kind: "incoming" } as const satisfies FlagSource;
const localFlagSource = { kind: "local" } as const satisfies FlagSource;
