import { assert } from "#common/assert.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#core/flags/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import {
  simpleFlagSourceConditionOperators,
  statusFlagValuesForSource,
  type SimpleFlagSource
} from "#core/flags/lazy/sources.js";
import type { StatusFlagValues } from "#core/flags/values.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type { RegionBuilder, SwitchArm } from "#compiler/ir/builder/region.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import { flagStateFields, type FlagStateField } from "#core/flags/layout.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { BoundStateAccess } from "#core/state/access.js";

export type FlagStateStorage = Readonly<{
  read(access: BoundStateAccess, field: FlagStateField): ValueId;
  write(field: FlagStateField, value: ValueId): void;
  invalidate(field: FlagStateField): void;
}>;

export type StatusFlagContext = Readonly<{
  region: RegionBuilder;
  access: BoundStateAccess;
}>;

export type ResolveStatusFlagFromState = (
  context: StatusFlagContext,
  flag: X86StatusFlag
) => ValueId;

type FlagSourceId = number;

type UndefFlagPolicy = "zero";

type FlagBacking =
  | Readonly<{ kind: "source"; source: FlagSourceId }>
  | Readonly<{ kind: "value"; value: ValueId }>
  | Readonly<{ kind: "input"; flag: X86StatusFlag }>
  | Readonly<{ kind: "undef"; policy: UndefFlagPolicy }>;

type StatusFlagValueIds = StatusFlagValues;
type SourceExpansionCache = Map<FlagSourceId, StatusFlagValueIds>;
type FlagBoolExprFlagResolver = (flag: X86StatusFlag) => ValueId;
type StatusFlagTrackerState = {
  backings: Map<X86StatusFlag, FlagBacking>;
  directSource: FlagSourceId | undefined;
};
type StatusFlagTrackerSnapshot = Readonly<{
  sourcesLength: number;
  current: StatusFlagTrackerState;
  inputFlags: ReadonlyMap<X86StatusFlag, ValueId>;
}>;
type LazyFlagRecordValues = Readonly<{
  kind: ValueId;
  a: ValueId;
  b: ValueId;
}>;

const logicUndefFlagPolicy: UndefFlagPolicy = "zero";
const lazyConditionWidths = [8, 16, 32] as const;
type LazyConditionCaseSpec = Readonly<{
  kind:
    typeof LAZY_FLAGS_KIND.ADD | typeof LAZY_FLAGS_KIND.SUB | typeof LAZY_FLAGS_KIND.LOGIC_RESULT;
  width: (typeof lazyConditionWidths)[number];
  operator: CompareOperator;
}>;

export class StatusFlagTracker {
  readonly #state: FlagStateStorage;
  readonly #resolveFlagFromState: ResolveStatusFlagFromState;
  readonly #recordSourceWrite: (() => void) | undefined;
  readonly #sources: SimpleFlagSource[] = [];
  readonly #current = initialStatusFlagState();
  readonly #inputFlags = new Map<X86StatusFlag, ValueId>();

  constructor(
    state: FlagStateStorage,
    resolveFlagFromState: ResolveStatusFlagFromState,
    recordSourceWrite?: () => void
  ) {
    this.#state = state;
    this.#resolveFlagFromState = resolveFlagFromState;
    this.#recordSourceWrite = recordSourceWrite;
  }

  read(context: StatusFlagContext, flag: X86StatusFlag): ValueId {
    return this.#resolveFlagFrom(context, this.#current, flag, new Map());
  }

  condition(context: StatusFlagContext, cc: ConditionCode): ValueId {
    const direct = this.#directCondition(context, cc);

    if (direct !== undefined) {
      return direct;
    }

    const lazy = this.#lazyInputCondition(context, cc);

    if (lazy !== undefined) {
      return lazy;
    }

    const cache: SourceExpansionCache = new Map();

    return this.#flagBoolExpr(context, CONDITIONS[cc].expr, (flag) =>
      this.#resolveFlagFrom(context, this.#current, flag, cache)
    );
  }

  writeSource(context: StatusFlagContext, source: SimpleFlagSource): void {
    const sourceId = this.#sources.length;

    this.#sources.push(source);
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
        const zero = context.region.values.const(0);

        this.#setBacking("CF", { kind: "value", value: zero });
        this.#setBacking("PF", { kind: "source", source: sourceId });
        this.#setBacking("AF", { kind: "undef", policy: logicUndefFlagPolicy });
        this.#setBacking("ZF", { kind: "source", source: sourceId });
        this.#setBacking("SF", { kind: "source", source: sourceId });
        this.#setBacking("OF", { kind: "value", value: zero });
        this.#writeLazyLogicSource(context, source);
        return;
      }
    }
  }

  write(context: StatusFlagContext, targetFlag: X86StatusFlag, value: ValueId): void {
    if (this.#isCurrentFlagValue(context, targetFlag, value)) {
      return;
    }

    this.#flushBeforeDirectFlagWrite(context);
    this.#writeExplicitFlag(targetFlag, value);
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

  // Forgets every tracked backing and cached resolve: flag reads go back to
  // the flag state in memory. If later reads can occur inside an if/switch
  // arm, first discard lazy writes created after the instruction boundary;
  // an arm-local resolver would have no older value to restore.
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
    const values = Object.fromEntries(
      x86StatusFlags.map((flag) => [
        flag,
        this.#resolveFlagFrom(context, this.#current, flag, cache)
      ])
    ) as StatusFlagValueIds;

    // Direct flag writes switch status flags into explicit mode. The first
    // write must publish a complete status image before overriding one flag,
    // otherwise later paths could mix stale explicit bytes with invalidated
    // lazy metadata.
    this.#current.directSource = undefined;
    this.#invalidateLazyFields();
    for (const flag of x86StatusFlags) {
      this.#writeExplicitFlag(flag, values[flag]);
    }
    this.#state.write(flagStateFields.lazyKind, context.region.values.const(0));
  }

  #writeExplicitFlag(flag: X86StatusFlag, value: ValueId): void {
    this.#setBacking(flag, { kind: "value", value });
    this.#state.write(flagStateFields.concrete[flag], value);
  }

  #isCurrentFlagValue(context: StatusFlagContext, flag: X86StatusFlag, value: ValueId): boolean {
    const backing = getBacking(this.#current.backings, flag);

    switch (backing.kind) {
      case "source":
        return this.#sourceValues(context, backing.source, new Map())[flag] === value;
      case "value":
        return backing.value === value;
      case "input":
        return this.#inputFlags.get(backing.flag) === value;
      case "undef":
        return backing.policy === "zero" && value === context.region.values.const(0);
    }
  }

  #hasInputBackings(): boolean {
    return x86StatusFlags.some((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #writeLazyBinarySource(
    context: StatusFlagContext,
    source: SimpleFlagSource & Readonly<{ kind: "add" | "sub" }>
  ): void {
    const kind = source.kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB;
    const values = context.region.values;

    this.#invalidateExplicitFlagFields();
    this.#state.invalidate(flagStateFields.lazyKind);
    this.#state.write(flagStateFields.lazyA, values.truncate(source.width, source.left));
    this.#state.write(flagStateFields.lazyB, values.truncate(source.width, source.right));
    this.#state.write(
      flagStateFields.lazyKind,
      values.const(lazyFlagsKindByte(kind, source.width))
    );
  }

  #writeLazyLogicSource(
    context: StatusFlagContext,
    source: SimpleFlagSource & Readonly<{ kind: "logic" }>
  ): void {
    const values = context.region.values;

    this.#invalidateExplicitFlagFields();
    this.#state.invalidate(flagStateFields.lazyKind);
    this.#state.write(flagStateFields.lazyA, values.truncate(source.width, source.result));
    this.#state.invalidate(flagStateFields.lazyB);
    this.#state.write(
      flagStateFields.lazyKind,
      values.const(lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, source.width))
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
  ): ValueId {
    return this.#resolveBacking(context, flag, getBacking(state.backings, flag), cache);
  }

  #resolveBacking(
    context: StatusFlagContext,
    flag: X86StatusFlag,
    backing: FlagBacking,
    cache: SourceExpansionCache
  ): ValueId {
    switch (backing.kind) {
      case "source":
        return this.#sourceValues(context, backing.source, cache)[flag];
      case "value":
        return backing.value;
      case "input":
        return this.#readInputFlag(context, backing.flag);
      case "undef":
        return this.#materializeUndef(context, backing.policy);
    }
  }

  #directCondition(context: StatusFlagContext, cc: ConditionCode): ValueId | undefined {
    if (this.#current.directSource === undefined) {
      return undefined;
    }

    const source = this.#source(this.#current.directSource);
    const operator = simpleFlagSourceConditionOperators[source.kind][cc];
    const values = context.region.values;

    if (operator === undefined) {
      return undefined;
    }

    switch (source.kind) {
      case "add":
      case "sub":
        return values.compare(source.width, operator, source.left, source.right);
      case "logic":
        return values.compare(source.width, operator, source.result, values.const(0));
    }
  }

  #lazyInputCondition(context: StatusFlagContext, cc: ConditionCode): ValueId | undefined {
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

  #lazyConditionArm(spec: LazyConditionCaseSpec, record: LazyFlagRecordValues): SwitchArm {
    return {
      match: lazyFlagsKindByte(spec.kind, spec.width),
      build: (arm) =>
        arm.values.compare(
          spec.width,
          spec.operator,
          record.a,
          spec.kind === LAZY_FLAGS_KIND.LOGIC_RESULT ? arm.values.const(0) : record.b
        )
    };
  }

  #lazyConditionDefault(context: StatusFlagContext, expr: FlagBoolExpr): ValueId {
    const flags = new Map<X86StatusFlag, ValueId>();

    return this.#flagBoolExpr(context, expr, (flag) => {
      const cached = flags.get(flag);

      if (cached !== undefined) {
        return cached;
      }

      const resolved = this.#resolveFlagFromState(context, flag);

      flags.set(flag, resolved);
      return resolved;
    });
  }

  #flagBoolExpr(
    context: StatusFlagContext,
    expr: FlagBoolExpr,
    resolveFlag: FlagBoolExprFlagResolver
  ): ValueId {
    const values = context.region.values;

    switch (expr.kind) {
      case "flag":
        return resolveFlag(expr.flag);
      case "not":
        return values.compare(
          32,
          "eq",
          this.#flagBoolExpr(context, expr.value, resolveFlag),
          values.const(0)
        );
      case "and":
        return values.binary(
          "and",
          this.#flagBoolExpr(context, expr.a, resolveFlag),
          this.#flagBoolExpr(context, expr.b, resolveFlag)
        );
      case "or":
        return values.binary(
          "or",
          this.#flagBoolExpr(context, expr.a, resolveFlag),
          this.#flagBoolExpr(context, expr.b, resolveFlag)
        );
      case "xor":
        return values.binary(
          "xor",
          this.#flagBoolExpr(context, expr.a, resolveFlag),
          this.#flagBoolExpr(context, expr.b, resolveFlag)
        );
    }
  }

  #readInputFlag(context: StatusFlagContext, flag: X86StatusFlag): ValueId {
    const cached = this.#inputFlags.get(flag);

    if (cached !== undefined) {
      return cached;
    }

    const resolved = this.#resolveFlagFromState(context, flag);

    this.#inputFlags.set(flag, resolved);
    return resolved;
  }

  #captureLazyFlagRecord(access: BoundStateAccess): LazyFlagRecordValues {
    // Keep joined or loop-carried lazy records coherent.
    return {
      kind: this.#state.read(access, flagStateFields.lazyKind),
      a: this.#state.read(access, flagStateFields.lazyA),
      b: this.#state.read(access, flagStateFields.lazyB)
    };
  }

  #source(sourceId: FlagSourceId): SimpleFlagSource {
    const source = this.#sources[sourceId];

    assert(source !== undefined, `unknown flag source ${sourceId}`);

    return source;
  }

  #sourceValues(
    context: StatusFlagContext,
    sourceId: FlagSourceId,
    cache: SourceExpansionCache
  ): StatusFlagValueIds {
    const cached = cache.get(sourceId);

    if (cached !== undefined) {
      return cached;
    }

    const materialized = this.#materializeSource(context, this.#source(sourceId));

    cache.set(sourceId, materialized);
    return materialized;
  }

  #materializeUndef(context: StatusFlagContext, policy: UndefFlagPolicy): ValueId {
    switch (policy) {
      case "zero":
        return context.region.values.const(0);
    }
  }

  #materializeSource(context: StatusFlagContext, source: SimpleFlagSource): StatusFlagValueIds {
    return statusFlagValuesForSource(context.region.values, source, {
      undefinedAF: this.#materializeUndef(context, logicUndefFlagPolicy)
    });
  }
}

function initialBackings(): Map<X86StatusFlag, FlagBacking> {
  return new Map(x86StatusFlags.map((flag) => [flag, { kind: "input", flag }]));
}

function lazyRuntimeConditionCaseSpecs(cc: ConditionCode): readonly LazyConditionCaseSpec[] {
  return lazyConditionWidths.flatMap((width) => [
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
