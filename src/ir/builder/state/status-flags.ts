import { assert } from "#common/assert.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#core/flags/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import {
  simpleFlagSourceConditionOperators,
  type SimpleFlagSource
} from "#core/flags/sources.js";
import {
  statusFlagValuesForSource,
  type StatusFlagValues
} from "#core/flags/values.js";
import { statusFlagResolvers } from "#core/flags/resolvers.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type { BodyBuilder, SwitchArm } from "../../body-builder.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "../../lazy-flags.js";
import { valueTableFlagOps } from "../../flag-value-ops.js";
import {
  flagChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel
} from "../../slots.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { StateCells } from "./cells.js";
import type { StateWriteObserver } from "./write-log.js";

export type FlagSourceId = number;

export type UndefFlagPolicy = "zero";

type FlagBacking =
  | Readonly<{ kind: "source"; source: FlagSourceId }>
  | Readonly<{ kind: "value"; value: ValueId }>
  | Readonly<{ kind: "input"; flag: X86StatusFlag }>
  | Readonly<{ kind: "undef"; policy: UndefFlagPolicy }>;

type StatusFlagValueIds = StatusFlagValues<ValueId>;
type SourceExpansionCache = Map<FlagSourceId, StatusFlagValueIds>;
type FlagBoolExprFlagResolver = (flag: X86StatusFlag) => ValueId;
type StatusFlagTrackerState = {
  backings: Map<X86StatusFlag, FlagBacking>;
  directSource: FlagSourceId | undefined;
};
type StatusFlagStateSnapshot = Readonly<{
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
  kind: typeof LAZY_FLAGS_KIND.ADD | typeof LAZY_FLAGS_KIND.SUB | typeof LAZY_FLAGS_KIND.LOGIC_RESULT;
  width: (typeof lazyConditionWidths)[number];
  operator: CompareOperator;
}>;

export class StatusFlagState {
  readonly #values: ValueTable;
  readonly #cells: StateCells;
  readonly #currentBody: () => BodyBuilder;
  readonly #writeObserver: StateWriteObserver | undefined;
  readonly #sources: SimpleFlagSource<ValueId>[] = [];
  readonly #current = initialStatusFlagState();
  readonly #inputFlags = new Map<X86StatusFlag, ValueId>();
  readonly #valueOps: ReturnType<typeof valueTableFlagOps>;

  constructor(
    values: ValueTable,
    cells: StateCells,
    currentBody: () => BodyBuilder,
    writeObserver?: StateWriteObserver
  ) {
    this.#values = values;
    this.#cells = cells;
    this.#currentBody = currentBody;
    this.#writeObserver = writeObserver;
    this.#valueOps = valueTableFlagOps(values);
  }

  read(flag: X86StatusFlag): ValueId {
    return this.#resolveFlagFrom(this.#current, flag, new Map());
  }

  condition(cc: ConditionCode): ValueId {
    const direct = this.#directCondition(cc);

    if (direct !== undefined) {
      return direct;
    }

    const lazy = this.#lazyInputCondition(cc);

    if (lazy !== undefined) {
      return lazy;
    }

    const cache: SourceExpansionCache = new Map();

    return this.#flagBoolExpr(
      CONDITIONS[cc].expr,
      (flag) => this.#resolveFlagFrom(this.#current, flag, cache)
    );
  }

  writeSource(source: SimpleFlagSource<ValueId>): void {
    const sourceId = this.#sources.length;

    this.#sources.push(source);
    this.#current.directSource = sourceId;
    this.#writeObserver?.recordStatusFlagSourceWrite();

    switch (source.kind) {
      case "add":
      case "sub":
        for (const flag of x86StatusFlags) {
          this.#setBacking(flag, { kind: "source", source: sourceId });
        }
        this.#writeLazyBinarySource(source);
        return;
      case "logic": {
        const zero = this.#values.const(0);

        this.#setBacking("CF", { kind: "value", value: zero });
        this.#setBacking("PF", { kind: "source", source: sourceId });
        this.#setBacking("AF", { kind: "undef", policy: logicUndefFlagPolicy });
        this.#setBacking("ZF", { kind: "source", source: sourceId });
        this.#setBacking("SF", { kind: "source", source: sourceId });
        this.#setBacking("OF", { kind: "value", value: zero });
        this.#writeLazyLogicSource(source);
        return;
      }
    }
  }

  write(targetFlag: X86StatusFlag, value: ValueId): void {
    if (this.#isCurrentFlagValue(targetFlag, value)) {
      return;
    }

    this.#flushBeforeDirectFlagWrite();
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
  // the flag state in memory. Used when that state was rewritten behind the
  // tracker's back — a loop body's carried lazy cells.
  resetToInputs(): void {
    this.#current.directSource = undefined;
    this.#current.backings.clear();
    for (const [flag, backing] of initialBackings()) {
      this.#current.backings.set(flag, backing);
    }

    this.#inputFlags.clear();
  }

  snapshot(): StatusFlagStateSnapshot {
    return {
      sourcesLength: this.#sources.length,
      current: {
        backings: new Map(this.#current.backings),
        directSource: this.#current.directSource
      },
      inputFlags: new Map(this.#inputFlags)
    };
  }

  restore(snapshot: StatusFlagStateSnapshot): void {
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

  #flushBeforeDirectFlagWrite(): void {
    if (this.#current.directSource !== undefined || this.#hasInputBackings()) {
      this.#flushExplicitFlagsFromBackings();
    }
  }

  #flushExplicitFlagsFromBackings(): void {
    const cache: SourceExpansionCache = new Map();
    const values = Object.fromEntries(
      x86StatusFlags.map((flag) => [
        flag,
        this.#resolveFlagFrom(this.#current, flag, cache)
      ])
    ) as StatusFlagValueIds;

    // Direct flag writes switch status flags into explicit mode. The first
    // write must publish a complete status image before overriding one flag,
    // otherwise later paths could mix stale explicit bytes with invalidated
    // lazy metadata.
    this.#current.directSource = undefined;
    this.#invalidateLazyChannels();
    for (const flag of x86StatusFlags) {
      this.#writeExplicitFlag(flag, values[flag]);
    }
    this.#cells.write(lazyFlagsKindChannel, this.#values.const(0));
  }

  #writeExplicitFlag(flag: X86StatusFlag, value: ValueId): void {
    this.#setBacking(flag, { kind: "value", value });
    this.#cells.write(flagChannel(flag), value);
  }

  #isCurrentFlagValue(flag: X86StatusFlag, value: ValueId): boolean {
    const backing = getBacking(this.#current.backings, flag);

    switch (backing.kind) {
      case "source":
        return this.#sourceValues(backing.source, new Map())[flag] === value;
      case "value":
        return backing.value === value;
      case "input":
        return this.#inputFlags.get(backing.flag) === value;
      case "undef":
        return backing.policy === "zero" && value === this.#values.const(0);
    }
  }

  #hasInputBackings(): boolean {
    return x86StatusFlags.some((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #writeLazyBinarySource(source: SimpleFlagSource<ValueId> & Readonly<{ kind: "add" | "sub" }>): void {
    const kind = source.kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB;

    this.#invalidateExplicitFlagChannels();
    this.#cells.invalidate(lazyFlagsKindChannel);
    this.#cells.write(lazyFlagsAChannel, this.#values.truncate(source.width, source.left));
    this.#cells.write(lazyFlagsBChannel, this.#values.truncate(source.width, source.right));
    this.#cells.write(
      lazyFlagsKindChannel,
      this.#values.const(lazyFlagsKindByte(kind, source.width))
    );
  }

  #writeLazyLogicSource(source: SimpleFlagSource<ValueId> & Readonly<{ kind: "logic" }>): void {
    this.#invalidateExplicitFlagChannels();
    this.#cells.invalidate(lazyFlagsKindChannel);
    this.#cells.write(lazyFlagsAChannel, this.#values.truncate(source.width, source.result));
    this.#cells.invalidate(lazyFlagsBChannel);
    this.#cells.write(
      lazyFlagsKindChannel,
      this.#values.const(lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, source.width))
    );
  }

  #invalidateExplicitFlagChannels(): void {
    for (const flag of x86StatusFlags) {
      this.#cells.invalidate(flagChannel(flag));
    }
  }

  #invalidateLazyChannels(): void {
    this.#cells.invalidate(lazyFlagsAChannel);
    this.#cells.invalidate(lazyFlagsBChannel);
    this.#cells.invalidate(lazyFlagsKindChannel);
  }

  #resolveFlagFrom(
    state: StatusFlagTrackerState,
    flag: X86StatusFlag,
    cache: SourceExpansionCache
  ): ValueId {
    return this.#resolveBacking(flag, getBacking(state.backings, flag), cache);
  }

  #resolveBacking(
    flag: X86StatusFlag,
    backing: FlagBacking,
    cache: SourceExpansionCache
  ): ValueId {
    switch (backing.kind) {
      case "source":
        return this.#sourceValues(backing.source, cache)[flag];
      case "value":
        return backing.value;
      case "input":
        return this.#readInputFlag(backing.flag);
      case "undef":
        return this.#materializeUndef(backing.policy);
    }
  }

  #directCondition(cc: ConditionCode): ValueId | undefined {
    if (this.#current.directSource === undefined) {
      return undefined;
    }

    const source = this.#source(this.#current.directSource);
    const operator = simpleFlagSourceConditionOperators[source.kind][cc];

    if (operator === undefined) {
      return undefined;
    }

    switch (source.kind) {
      case "add":
      case "sub":
        return this.#values.compare(source.width, operator, source.left, source.right);
      case "logic":
        return this.#values.compare(source.width, operator, source.result, this.#values.const(0));
    }
  }

  #lazyInputCondition(cc: ConditionCode): ValueId | undefined {
    const caseSpecs = lazyRuntimeConditionCaseSpecs(cc);

    if (caseSpecs.length === 0 || !this.#conditionReadsOnlyInputFlags(cc)) {
      return undefined;
    }

    const record = this.#captureLazyFlagRecord();

    return this.#currentBody().switch(
      record.kind,
      caseSpecs.map((spec) => this.#lazyConditionArm(spec, record)),
      (arm) => this.#lazyConditionDefault(arm, CONDITIONS[cc].expr, record)
    );
  }

  #conditionReadsOnlyInputFlags(cc: ConditionCode): boolean {
    return CONDITIONS[cc].reads.every((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #lazyConditionArm(
    spec: LazyConditionCaseSpec,
    record: LazyFlagRecordValues
  ): SwitchArm {
    return {
      match: lazyFlagsKindByte(spec.kind, spec.width),
      build: (arm) => arm.values.compare(
        spec.width,
        spec.operator,
        record.a,
        spec.kind === LAZY_FLAGS_KIND.LOGIC_RESULT ? arm.values.const(0) : record.b
      )
    };
  }

  #lazyConditionDefault(
    body: BodyBuilder,
    expr: FlagBoolExpr,
    record: LazyFlagRecordValues
  ): ValueId {
    const flags = new Map<X86StatusFlag, ValueId>();

    return this.#flagBoolExpr(expr, (flag) => {
      const cached = flags.get(flag);

      if (cached !== undefined) {
        return cached;
      }

      const resolved = this.#callStatusFlagResolver(body, flag, record);

      flags.set(flag, resolved);
      return resolved;
    });
  }

  #flagBoolExpr(expr: FlagBoolExpr, resolveFlag: FlagBoolExprFlagResolver): ValueId {
    switch (expr.kind) {
      case "flag":
        return resolveFlag(expr.flag);
      case "not":
        return this.#values.compare(
          32,
          "eq",
          this.#flagBoolExpr(expr.value, resolveFlag),
          this.#values.const(0)
        );
      case "and":
        return this.#values.binary(
          "and",
          this.#flagBoolExpr(expr.a, resolveFlag),
          this.#flagBoolExpr(expr.b, resolveFlag)
        );
      case "or":
        return this.#values.binary(
          "or",
          this.#flagBoolExpr(expr.a, resolveFlag),
          this.#flagBoolExpr(expr.b, resolveFlag)
        );
      case "xor":
        return this.#values.binary(
          "xor",
          this.#flagBoolExpr(expr.a, resolveFlag),
          this.#flagBoolExpr(expr.b, resolveFlag)
        );
    }
  }

  #readInputFlag(flag: X86StatusFlag): ValueId {
    const cached = this.#inputFlags.get(flag);

    if (cached !== undefined) {
      return cached;
    }

    const resolved = this.#callStatusFlagResolver(
      this.#currentBody(),
      flag,
      this.#captureLazyFlagRecord()
    );

    this.#inputFlags.set(flag, resolved);
    return resolved;
  }

  #captureLazyFlagRecord(): LazyFlagRecordValues {
    // "Input-backed" means the value belongs to the incoming StateCells
    // snapshot, not necessarily that it must be loaded from memory here.
    // Capture the three fields together so joined/carried SSA state reaches
    // the resolver as one coherent lazy record.
    return {
      kind: this.#cells.read(lazyFlagsKindChannel),
      a: this.#cells.read(lazyFlagsAChannel),
      b: this.#cells.read(lazyFlagsBChannel)
    };
  }

  #callStatusFlagResolver(
    body: BodyBuilder,
    flag: X86StatusFlag,
    record: LazyFlagRecordValues
  ): ValueId {
    const concrete = this.#cells.read(flagChannel(flag));
    const [resolved] = body.call(statusFlagResolvers.get(flag), [
      record.kind,
      record.a,
      record.b,
      concrete
    ]);

    assert(resolved !== undefined, `status-flag resolver for ${flag} has no result`);
    return resolved;
  }

  #source(sourceId: FlagSourceId): SimpleFlagSource<ValueId> {
    const source = this.#sources[sourceId];

    assert(source !== undefined, `unknown flag source ${sourceId}`);

    return source;
  }

  #sourceValues(sourceId: FlagSourceId, cache: SourceExpansionCache): StatusFlagValueIds {
    const cached = cache.get(sourceId);

    if (cached !== undefined) {
      return cached;
    }

    const materialized = this.#materializeSource(this.#source(sourceId));

    cache.set(sourceId, materialized);
    return materialized;
  }

  #materializeUndef(policy: UndefFlagPolicy): ValueId {
    switch (policy) {
      case "zero":
        return this.#values.const(0);
    }
  }

  #materializeSource(source: SimpleFlagSource<ValueId>): StatusFlagValueIds {
    return statusFlagValuesForSource(this.#valueOps, source, {
      undefinedAF: this.#materializeUndef(logicUndefFlagPolicy)
    });
  }
}

function initialBackings(): Map<X86StatusFlag, FlagBacking> {
  return new Map(x86StatusFlags.map((flag) => [flag, { kind: "input", flag }]));
}

function lazyRuntimeConditionCaseSpecs(cc: ConditionCode): readonly LazyConditionCaseSpec[] {
  return lazyConditionWidths.flatMap((width) => [
    ...lazyRuntimeConditionCase(LAZY_FLAGS_KIND.ADD, width, simpleFlagSourceConditionOperators.add[cc]),
    ...lazyRuntimeConditionCase(LAZY_FLAGS_KIND.SUB, width, simpleFlagSourceConditionOperators.sub[cc]),
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

function getBacking(
  backings: ReadonlyMap<X86StatusFlag, FlagBacking>,
  flag: X86StatusFlag
): FlagBacking {
  const backing = backings.get(flag);

  assert(backing !== undefined, `missing status flag backing for ${flag}`);

  return backing;
}
