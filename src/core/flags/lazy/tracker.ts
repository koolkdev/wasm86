import { assert } from "#common/assert.js";
import type { RegionBuilder, SwitchArm } from "#compiler/function/builder/region.js";
import type { CompareOperator } from "#compiler/function/values/integer/operators.js";
import {
  integer,
  i32,
  type BitValue,
  type I32Value,
  type Integer
} from "#compiler/function/values.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#core/flags/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte, lazyFlagWidths } from "#core/flags/lazy/encoding.js";
import {
  simpleFlagSourceConditionOperators,
  statusFlagValuesForSource,
  type SimpleFlagSource
} from "#core/flags/lazy/sources.js";
import { flagStateFields, type FlagStateField } from "#core/flags/layout.js";
import type { StatusFlagValues } from "#core/flags/values.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { OperandWidth } from "#core/types.js";

export type FlagStateStorage = Readonly<{
  read(access: BoundStateAccess, field: FlagStateField): I32Value;
  write(access: BoundStateAccess, field: FlagStateField, value: I32Value): void;
  invalidate(field: FlagStateField): void;
}>;

export type StatusFlagContext = Readonly<{
  region: RegionBuilder;
  access: BoundStateAccess;
}>;

export type ResolveStatusFlagFromState = (
  context: StatusFlagContext,
  flag: X86StatusFlag
) => BitValue;

type FlagSourceId = number;
type UndefFlagPolicy = "zero";

type FlagBacking =
  | Readonly<{ kind: "source"; source: FlagSourceId }>
  | Readonly<{ kind: "value"; value: BitValue }>
  | Readonly<{ kind: "input"; flag: X86StatusFlag }>
  | Readonly<{ kind: "undef"; policy: UndefFlagPolicy }>;

type SourceExpansionCache = Map<FlagSourceId, StatusFlagValues>;
type TrackedFlagSource = Readonly<{
  condition(cc: ConditionCode): BitValue | undefined;
  values(undefinedAF: BitValue): StatusFlagValues;
}>;
type FlagBoolExprFlagResolver = (flag: X86StatusFlag) => BitValue;
type StatusFlagTrackerState = {
  backings: Map<X86StatusFlag, FlagBacking>;
  directSource: FlagSourceId | undefined;
};
type StatusFlagTrackerSnapshot = Readonly<{
  sourcesLength: number;
  current: StatusFlagTrackerState;
  inputFlags: ReadonlyMap<X86StatusFlag, BitValue>;
}>;
type LazyFlagRecordValues = Readonly<{
  kind: I32Value;
  a: I32Value;
  b: I32Value;
}>;
type LazyConditionCaseSpec = Readonly<{
  kind:
    typeof LAZY_FLAGS_KIND.ADD | typeof LAZY_FLAGS_KIND.SUB | typeof LAZY_FLAGS_KIND.LOGIC_RESULT;
  width: (typeof lazyFlagWidths)[number];
  operator: CompareOperator;
}>;

const logicUndefFlagPolicy: UndefFlagPolicy = "zero";

export class StatusFlagTracker {
  readonly #state: FlagStateStorage;
  readonly #resolveFlagFromState: ResolveStatusFlagFromState;
  readonly #recordSourceWrite: (() => void) | undefined;
  readonly #sources: TrackedFlagSource[] = [];
  readonly #current = initialStatusFlagState();
  readonly #inputFlags = new Map<X86StatusFlag, BitValue>();

  constructor(
    state: FlagStateStorage,
    resolveFlagFromState: ResolveStatusFlagFromState,
    recordSourceWrite?: () => void
  ) {
    this.#state = state;
    this.#resolveFlagFromState = resolveFlagFromState;
    this.#recordSourceWrite = recordSourceWrite;
  }

  read(context: StatusFlagContext, flag: X86StatusFlag): BitValue {
    return this.#resolveFlagFrom(context, this.#current, flag, new Map());
  }

  condition(context: StatusFlagContext, cc: ConditionCode): BitValue {
    const direct = this.#directCondition(cc);

    if (direct !== undefined) {
      return direct;
    }

    const lazy = this.#lazyInputCondition(context, cc);

    if (lazy !== undefined) {
      return lazy;
    }

    const cache: SourceExpansionCache = new Map();

    return this.#flagBoolExpr(CONDITIONS[cc].expr, (flag) =>
      this.#resolveFlagFrom(context, this.#current, flag, cache)
    );
  }

  writeSource<Width extends OperandWidth>(
    context: StatusFlagContext,
    source: SimpleFlagSource<Width>
  ): void {
    const sourceId = this.#sources.length;

    this.#sources.push(trackFlagSourceAtWidth(source));
    this.#current.directSource = sourceId;
    this.#recordSourceWrite?.();

    switch (source.kind) {
      case "add":
      case "sub":
        for (const flag of x86StatusFlags) {
          this.#setBacking(flag, { kind: "source", source: sourceId });
        }
        this.#writeLazyBinarySource(context, source);
        return;
      case "logic": {
        const clearedFlag = integer(1, 0);

        this.#setBacking("CF", { kind: "value", value: clearedFlag });
        this.#setBacking("PF", { kind: "source", source: sourceId });
        this.#setBacking("AF", { kind: "undef", policy: logicUndefFlagPolicy });
        this.#setBacking("ZF", { kind: "source", source: sourceId });
        this.#setBacking("SF", { kind: "source", source: sourceId });
        this.#setBacking("OF", { kind: "value", value: clearedFlag });
        this.#writeLazyLogicSource(context, source);
        return;
      }
    }
  }

  write(context: StatusFlagContext, targetFlag: X86StatusFlag, value: BitValue): void {
    if (this.#isCurrentFlagValue(context, targetFlag, value)) {
      return;
    }

    this.#flushBeforeDirectFlagWrite(context);
    this.#writeExplicitFlag(context.access, targetFlag, value);
  }

  has(flag: X86StatusFlag): boolean {
    return getBacking(this.#current.backings, flag).kind !== "input";
  }

  isInputBacked(flag: X86StatusFlag): boolean {
    return getBacking(this.#current.backings, flag).kind === "input";
  }

  conditionReadsInputFlags(cc: ConditionCode): boolean {
    return CONDITIONS[cc].reads.some((flag) => this.isInputBacked(flag));
  }

  // Return reads to the architectural flag state after discarding the
  // instruction-local sources and resolved inputs.
  resetToInputs(): void {
    this.#current.directSource = undefined;
    this.#current.backings.clear();
    for (const [flag, backing] of initialBackings()) {
      this.#current.backings.set(flag, backing);
    }
    this.#inputFlags.clear();
  }

  snapshot(): StatusFlagTrackerSnapshot {
    return {
      sourcesLength: this.#sources.length,
      current: {
        backings: new Map(this.#current.backings),
        directSource: this.#current.directSource
      },
      inputFlags: new Map(this.#inputFlags)
    };
  }

  restore(snapshot: StatusFlagTrackerSnapshot): void {
    this.#sources.length = snapshot.sourcesLength;
    this.#current.directSource = snapshot.current.directSource;
    this.#current.backings.clear();

    for (const [flag, backing] of snapshot.current.backings) {
      this.#current.backings.set(flag, backing);
    }

    this.#inputFlags.clear();
    for (const [flag, value] of snapshot.inputFlags) {
      this.#inputFlags.set(flag, value);
    }
  }

  #setBacking(flag: X86StatusFlag, backing: FlagBacking): void {
    this.#current.backings.set(flag, backing);
  }

  #flushBeforeDirectFlagWrite(context: StatusFlagContext): void {
    if (this.#current.directSource !== undefined || this.#hasInputBackings()) {
      this.#flushExplicitFlagsFromBackings(context);
    }
  }

  #flushExplicitFlagsFromBackings(context: StatusFlagContext): void {
    const cache: SourceExpansionCache = new Map();
    const resolve = (flag: X86StatusFlag): BitValue =>
      this.#resolveFlagFrom(context, this.#current, flag, cache);
    const values: StatusFlagValues = {
      CF: resolve("CF"),
      PF: resolve("PF"),
      AF: resolve("AF"),
      ZF: resolve("ZF"),
      SF: resolve("SF"),
      OF: resolve("OF")
    };

    // Explicit mode needs a complete status image before one flag is
    // overwritten, or later paths could observe stale concrete bytes.
    this.#current.directSource = undefined;
    this.#invalidateLazyFields();
    for (const flag of x86StatusFlags) {
      this.#writeExplicitFlag(context.access, flag, values[flag]);
    }
    this.#state.write(context.access, flagStateFields.lazyKind, i32(0));
  }

  #writeExplicitFlag(access: BoundStateAccess, flag: X86StatusFlag, value: BitValue): void {
    this.#setBacking(flag, { kind: "value", value });
    this.#state.write(access, flagStateFields.concrete[flag], value.unsigned.extend(32));
  }

  #isCurrentFlagValue(context: StatusFlagContext, flag: X86StatusFlag, value: BitValue): boolean {
    const backing = getBacking(this.#current.backings, flag);

    switch (backing.kind) {
      case "source":
        return context.region.sameValue(this.#sourceValues(backing.source, new Map())[flag], value);
      case "value":
        return context.region.sameValue(backing.value, value);
      case "input": {
        const input = this.#inputFlags.get(backing.flag);

        return input !== undefined && context.region.sameValue(input, value);
      }
      case "undef":
        return backing.policy === "zero" && context.region.constValue(value) === 0;
    }
  }

  #hasInputBackings(): boolean {
    return x86StatusFlags.some((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #writeLazyBinarySource<Width extends OperandWidth>(
    context: StatusFlagContext,
    source: Extract<SimpleFlagSource<Width>, { kind: "add" | "sub" }>
  ): void {
    const kind = source.kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB;

    this.#invalidateExplicitFlagFields();
    this.#state.invalidate(flagStateFields.lazyKind);
    this.#state.write(context.access, flagStateFields.lazyA, source.left.unsigned.extend(32));
    this.#state.write(context.access, flagStateFields.lazyB, source.right.unsigned.extend(32));
    this.#state.write(
      context.access,
      flagStateFields.lazyKind,
      i32(lazyFlagsKindByte(kind, source.width))
    );
  }

  #writeLazyLogicSource<Width extends OperandWidth>(
    context: StatusFlagContext,
    source: Extract<SimpleFlagSource<Width>, { kind: "logic" }>
  ): void {
    this.#invalidateExplicitFlagFields();
    this.#state.invalidate(flagStateFields.lazyKind);
    this.#state.write(context.access, flagStateFields.lazyA, source.result.unsigned.extend(32));
    this.#state.invalidate(flagStateFields.lazyB);
    this.#state.write(
      context.access,
      flagStateFields.lazyKind,
      i32(lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, source.width))
    );
  }

  #invalidateExplicitFlagFields(): void {
    for (const flag of x86StatusFlags) {
      this.#state.invalidate(flagStateFields.concrete[flag]);
    }
  }

  #invalidateLazyFields(): void {
    this.#state.invalidate(flagStateFields.lazyA);
    this.#state.invalidate(flagStateFields.lazyB);
    this.#state.invalidate(flagStateFields.lazyKind);
  }

  #resolveFlagFrom(
    context: StatusFlagContext,
    state: StatusFlagTrackerState,
    flag: X86StatusFlag,
    cache: SourceExpansionCache
  ): BitValue {
    return this.#resolveBacking(context, flag, getBacking(state.backings, flag), cache);
  }

  #resolveBacking(
    context: StatusFlagContext,
    flag: X86StatusFlag,
    backing: FlagBacking,
    cache: SourceExpansionCache
  ): BitValue {
    switch (backing.kind) {
      case "source":
        return this.#sourceValues(backing.source, cache)[flag];
      case "value":
        return backing.value;
      case "input":
        return this.#readInputFlag(context, backing.flag);
      case "undef":
        return this.#undefinedValue(backing.policy);
    }
  }

  #directCondition(cc: ConditionCode): BitValue | undefined {
    if (this.#current.directSource === undefined) {
      return undefined;
    }

    return this.#source(this.#current.directSource).condition(cc);
  }

  #lazyInputCondition(context: StatusFlagContext, cc: ConditionCode): BitValue | undefined {
    const caseSpecs = lazyRuntimeConditionCaseSpecs(cc);

    if (caseSpecs.length === 0 || !this.#conditionReadsOnlyInputFlags(cc)) {
      return undefined;
    }

    const record = this.#captureLazyFlagRecord(context.access);

    return context.region.switch(
      record.kind,
      caseSpecs.map((spec) => this.#lazyConditionArm(spec, record)),
      (arm) => this.#lazyConditionDefault(contextForRegion(context, arm), CONDITIONS[cc].expr)
    );
  }

  #conditionReadsOnlyInputFlags(cc: ConditionCode): boolean {
    return CONDITIONS[cc].reads.every(
      (flag) => getBacking(this.#current.backings, flag).kind === "input"
    );
  }

  #lazyConditionArm(
    spec: LazyConditionCaseSpec,
    record: LazyFlagRecordValues
  ): SwitchArm<BitValue> {
    return {
      match: lazyFlagsKindByte(spec.kind, spec.width),
      build: () =>
        compareStoredValues(
          spec.width,
          spec.operator,
          record.a,
          spec.kind === LAZY_FLAGS_KIND.LOGIC_RESULT ? i32(0) : record.b
        )
    };
  }

  #lazyConditionDefault(context: StatusFlagContext, expr: FlagBoolExpr): BitValue {
    const flags = new Map<X86StatusFlag, BitValue>();

    return this.#flagBoolExpr(expr, (flag) => {
      const cached = flags.get(flag);

      if (cached !== undefined) {
        return cached;
      }

      const resolved = this.#resolveFlagFromState(context, flag);

      flags.set(flag, resolved);
      return resolved;
    });
  }

  #flagBoolExpr(expr: FlagBoolExpr, resolveFlag: FlagBoolExprFlagResolver): BitValue {
    switch (expr.kind) {
      case "flag":
        return resolveFlag(expr.flag);
      case "not":
        return this.#flagBoolExpr(expr.value, resolveFlag).eqz();
      case "and":
        return this.#flagBoolExpr(expr.a, resolveFlag).and(this.#flagBoolExpr(expr.b, resolveFlag));
      case "or":
        return this.#flagBoolExpr(expr.a, resolveFlag).or(this.#flagBoolExpr(expr.b, resolveFlag));
      case "xor":
        return this.#flagBoolExpr(expr.a, resolveFlag).xor(this.#flagBoolExpr(expr.b, resolveFlag));
    }
  }

  #readInputFlag(context: StatusFlagContext, flag: X86StatusFlag): BitValue {
    const cached = this.#inputFlags.get(flag);

    if (cached !== undefined) {
      return cached;
    }

    const resolved = this.#resolveFlagFromState(context, flag);

    this.#inputFlags.set(flag, resolved);
    return resolved;
  }

  #captureLazyFlagRecord(access: BoundStateAccess): LazyFlagRecordValues {
    // Capture the record once so joined and loop-carried reads stay coherent.
    return {
      kind: this.#state.read(access, flagStateFields.lazyKind),
      a: this.#state.read(access, flagStateFields.lazyA),
      b: this.#state.read(access, flagStateFields.lazyB)
    };
  }

  #source(sourceId: FlagSourceId): TrackedFlagSource {
    const source = this.#sources[sourceId];

    assert(source !== undefined, `unknown flag source ${sourceId}`);

    return source;
  }

  #sourceValues(sourceId: FlagSourceId, cache: SourceExpansionCache): StatusFlagValues {
    const cached = cache.get(sourceId);

    if (cached !== undefined) {
      return cached;
    }

    const values = this.#deriveSourceValues(this.#source(sourceId));

    cache.set(sourceId, values);
    return values;
  }

  #undefinedValue(policy: UndefFlagPolicy): BitValue {
    switch (policy) {
      case "zero":
        return integer(1, 0);
    }
  }

  #deriveSourceValues(source: TrackedFlagSource): StatusFlagValues {
    return source.values(this.#undefinedValue(logicUndefFlagPolicy));
  }
}

function initialBackings(): Map<X86StatusFlag, FlagBacking> {
  return new Map(x86StatusFlags.map((flag) => [flag, { kind: "input", flag }]));
}

function lazyRuntimeConditionCaseSpecs(cc: ConditionCode): readonly LazyConditionCaseSpec[] {
  return lazyFlagWidths.flatMap((width) => [
    ...lazyRuntimeConditionCase(
      LAZY_FLAGS_KIND.ADD,
      width,
      simpleFlagSourceConditionOperators.add[cc]
    ),
    ...lazyRuntimeConditionCase(
      LAZY_FLAGS_KIND.SUB,
      width,
      simpleFlagSourceConditionOperators.sub[cc]
    ),
    ...lazyRuntimeConditionCase(
      LAZY_FLAGS_KIND.LOGIC_RESULT,
      width,
      simpleFlagSourceConditionOperators.logic[cc]
    )
  ]);
}

function lazyRuntimeConditionCase(
  kind: LazyConditionCaseSpec["kind"],
  width: LazyConditionCaseSpec["width"],
  operator: CompareOperator | undefined
): readonly LazyConditionCaseSpec[] {
  return operator === undefined ? [] : [{ kind, width, operator }];
}

function initialStatusFlagState(): StatusFlagTrackerState {
  return {
    backings: initialBackings(),
    directSource: undefined
  };
}

function contextForRegion(context: StatusFlagContext, region: RegionBuilder): StatusFlagContext {
  return {
    region,
    access: context.access.forRegion(region)
  };
}

function getBacking(
  backings: ReadonlyMap<X86StatusFlag, FlagBacking>,
  flag: X86StatusFlag
): FlagBacking {
  const backing = backings.get(flag);

  assert(backing !== undefined, `missing status flag backing for ${flag}`);

  return backing;
}

function trackFlagSourceAtWidth<Width extends OperandWidth>(
  source: SimpleFlagSource<Width>
): TrackedFlagSource {
  return {
    condition: (cc) => {
      const operator = simpleFlagSourceConditionOperators[source.kind][cc];

      if (operator === undefined) {
        return undefined;
      }

      switch (source.kind) {
        case "add":
        case "sub":
          return compareValues(operator, source.left, source.right);
        case "logic":
          return compareValues(operator, source.result, integer(source.width, 0));
      }
    },
    values: (undefinedAF) => statusFlagValuesForSource(source, { undefinedAF })
  };
}

function compareStoredValues<Width extends OperandWidth>(
  width: Width,
  operator: CompareOperator,
  a: I32Value,
  b: I32Value
): BitValue {
  return compareValues(operator, a.truncate(width), b.truncate(width));
}

function compareValues<Width extends OperandWidth>(
  operator: CompareOperator,
  a: Integer<Width>,
  b: Integer<NoInfer<Width>>
): BitValue {
  switch (operator) {
    case "eq":
      return a.eq(b);
    case "ne":
      return a.ne(b);
    case "lt_u":
      return a.unsigned.lt(b);
    case "le_u":
      return a.unsigned.le(b);
    case "gt_u":
      return a.unsigned.gt(b);
    case "ge_u":
      return a.unsigned.ge(b);
    case "lt_s":
      return a.signed.lt(b);
    case "le_s":
      return a.signed.le(b);
    case "gt_s":
      return a.signed.gt(b);
    case "ge_s":
      return a.signed.ge(b);
  }
}
