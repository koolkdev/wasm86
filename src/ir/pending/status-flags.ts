import { assert } from "#common/assert.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#x86/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import {
  simpleFlagSourceConditionOperators,
  type SimpleFlagSource
} from "#x86/flag-sources.js";
import {
  statusFlagValuesForSource,
  type FlagValueOps,
  type StatusFlagValues
} from "#x86/flag-values.js";
import { signedComparePredicates, type CompareOperator } from "#x86/semantics/ops.js";
import { flagChannel, type FlagChannel } from "../slots.js";
import { fitsUnsigned, type ValueId, type ValueTable } from "../values.js";
import { StateAccess } from "./state-access.js";

export type FlagSourceId = number;

export type UndefFlagPolicy = "zero";

type FlagBacking =
  | Readonly<{ kind: "source"; source: FlagSourceId }>
  | Readonly<{ kind: "value"; value: ValueId }>
  | Readonly<{ kind: "input"; flag: X86StatusFlag }>
  | Readonly<{ kind: "undef"; policy: UndefFlagPolicy }>;

export type PendingStatusFlagEntry = readonly [FlagChannel<X86StatusFlag>, ValueId];

type StatusFlagValueIds = StatusFlagValues<ValueId>;
type SourceExpansionCache = Map<FlagSourceId, StatusFlagValueIds>;

const logicUndefFlagPolicy: UndefFlagPolicy = "zero";

export class PendingStatusFlags {
  readonly #values: ValueTable;
  readonly #state: StateAccess;
  readonly #sources: SimpleFlagSource<ValueId>[] = [];
  readonly #flagBackings = initialBackings();
  readonly #dirty = new Set<X86StatusFlag>();
  readonly #valueOps: FlagValueOps<ValueId>;
  #currentSource: FlagSourceId | undefined;
  #boundaryFlagBackings = new Map(this.#flagBackings);
  #boundaryDirty = new Set(this.#dirty);

  constructor(values: ValueTable, state: StateAccess) {
    this.#values = values;
    this.#state = state;
    this.#valueOps = flagValueOps(values);
  }

  readFlag(flag: X86StatusFlag): ValueId {
    return this.#resolveBacking(flag, getBacking(this.#flagBackings, flag), new Map());
  }

  condition(cc: ConditionCode): ValueId {
    return this.#directCondition(cc) ?? this.#flagBoolExpr(CONDITIONS[cc].expr, new Map());
  }

  writeStatusFlagsSource(source: SimpleFlagSource<ValueId>): void {
    const sourceId = this.#sources.length;

    this.#sources.push(source);
    this.#currentSource = sourceId;

    switch (source.kind) {
      case "add":
      case "sub":
        for (const flag of x86StatusFlags) {
          this.#setBacking(flag, { kind: "source", source: sourceId });
        }
        return;
      case "logic": {
        const zero = this.#values.internConst(0);

        this.#setBacking("CF", { kind: "value", value: zero });
        this.#setBacking("PF", { kind: "source", source: sourceId });
        this.#setBacking("AF", { kind: "undef", policy: logicUndefFlagPolicy });
        this.#setBacking("ZF", { kind: "source", source: sourceId });
        this.#setBacking("SF", { kind: "source", source: sourceId });
        this.#setBacking("OF", { kind: "value", value: zero });
        return;
      }
    }
  }

  writeFlag(flag: X86StatusFlag, value: ValueId): void {
    this.#currentSource = undefined;
    this.#setBacking(flag, { kind: "value", value });
  }

  has(flag: X86StatusFlag): boolean {
    return getBacking(this.#flagBackings, flag).kind !== "input";
  }

  #setBacking(flag: X86StatusFlag, backing: FlagBacking): void {
    this.#flagBackings.set(flag, backing);
    this.#dirty.add(flag);
  }

  #entriesFrom(
    sourceBackings: ReadonlyMap<X86StatusFlag, FlagBacking>,
    sourceDirty: ReadonlySet<X86StatusFlag>
  ): readonly PendingStatusFlagEntry[] {
    const cache: SourceExpansionCache = new Map();
    const entries: PendingStatusFlagEntry[] = [];

    for (const flag of x86StatusFlags) {
      if (sourceDirty.has(flag)) {
        entries.push([
          flagChannel(flag),
          this.#resolveBacking(flag, getBacking(sourceBackings, flag), cache)
        ]);
      }
    }

    return entries;
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
    if (this.#currentSource === undefined) {
      return undefined;
    }

    const source = this.#source(this.#currentSource);
    const operator = simpleFlagSourceConditionOperators[source.kind][cc];

    if (operator === undefined) {
      return undefined;
    }

    switch (source.kind) {
      case "add":
      case "sub":
        return this.#compare(source.width, operator, source.left, source.right);
      case "logic":
        return this.#compare(source.width, operator, source.result, this.#values.internConst(0));
    }
  }

  #flagBoolExpr(expr: FlagBoolExpr, cache: SourceExpansionCache): ValueId {
    switch (expr.kind) {
      case "flag":
        return this.#resolveBacking(expr.flag, getBacking(this.#flagBackings, expr.flag), cache);
      case "not":
        return this.#values.internCompare(
          "eq",
          this.#flagBoolExpr(expr.value, cache),
          this.#values.internConst(0)
        );
      case "and":
        return this.#values.internBinary(
          "and",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
      case "or":
        return this.#values.internBinary(
          "or",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
      case "xor":
        return this.#values.internBinary(
          "xor",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
    }
  }

  #readInputFlag(flag: X86StatusFlag): ValueId {
    return this.#state.readInput(flagChannel(flag), fitsUnsigned(1));
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
        return this.#values.internConst(0);
    }
  }

  beginInstruction(): void {
    this.#boundaryFlagBackings = new Map(this.#flagBackings);
    this.#boundaryDirty = new Set(this.#dirty);
  }

  snapshot(): readonly PendingStatusFlagEntry[] {
    return this.#entriesFrom(this.#boundaryFlagBackings, this.#boundaryDirty);
  }

  entries(): readonly PendingStatusFlagEntry[] {
    return this.#entriesFrom(this.#flagBackings, this.#dirty);
  }

  flushAll(): void {
    for (const [slot, value] of this.#entriesFrom(this.#flagBackings, this.#dirty)) {
      this.#state.write(slot, value);
    }

    this.#dirty.clear();
  }

  #materializeSource(source: SimpleFlagSource<ValueId>): StatusFlagValueIds {
    return statusFlagValuesForSource(this.#valueOps, source, {
      undefinedAF: this.#materializeUndef(logicUndefFlagPolicy)
    });
  }

  #compare(width: SimpleFlagSource<ValueId>["width"], operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    const lower = signedComparePredicates.has(operator)
      ? (id: ValueId) => this.#values.extendTo(width, id)
      : (id: ValueId) => this.#values.projectTo(width, id);

    return this.#values.internCompare(operator, lower(a), lower(b));
  }
}

function initialBackings(): Map<X86StatusFlag, FlagBacking> {
  return new Map(x86StatusFlags.map((flag) => [flag, { kind: "input", flag }]));
}

function flagValueOps(values: ValueTable): FlagValueOps<ValueId> {
  return {
    const32: (value) => values.internConst(value),
    project: (width, value) => values.projectTo(width, value),
    and: (a, b) => values.internBinary("and", a, b),
    xor: (a, b) => values.internBinary("xor", a, b),
    shrU: (a, b) => values.internBinary("shr_u", a, b),
    popcnt: (value) => values.internUnary("popcnt", value),
    compare: (width, operator, a, b) => (
      values.internCompare(operator, values.projectTo(width, a), values.projectTo(width, b))
    ),
    select: (condition, whenTrue, whenFalse) => (
      values.internSelect(condition, whenTrue, whenFalse)
    )
  };
}

function getBacking(
  backings: ReadonlyMap<X86StatusFlag, FlagBacking>,
  flag: X86StatusFlag
): FlagBacking {
  const backing = backings.get(flag);

  assert(backing !== undefined, `missing pending backing for ${flag}`);

  return backing;
}
