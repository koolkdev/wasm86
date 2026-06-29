import { assert } from "#common/assert.js";
import { CONDITIONS, type ConditionCode, type FlagBoolExpr } from "#x86/conditions.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import {
  simpleFlagSourceConditionOperators,
  type SimpleFlagSource
} from "#x86/flag-sources.js";
import {
  statusFlagValuesForSource,
  type StatusFlagValues
} from "#x86/flag-values.js";
import { signedComparePredicates, type CompareOperator } from "#x86/semantics/ops.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "./lazy-flags.js";
import { valueTableFlagOps } from "./flag-value-ops.js";
import {
  flagChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "./slots.js";
import { type ValueId, type ValueTable } from "./values.js";
import type { PendingState } from "./pending/state.js";

export type FlagSourceId = number;

export type UndefFlagPolicy = "zero";

type FlagBacking =
  | Readonly<{ kind: "source"; source: FlagSourceId }>
  | Readonly<{ kind: "value"; value: ValueId }>
  | Readonly<{ kind: "input"; flag: X86StatusFlag }>
  | Readonly<{ kind: "undef"; policy: UndefFlagPolicy }>;

type StatusFlagValueIds = StatusFlagValues<ValueId>;
type SourceExpansionCache = Map<FlagSourceId, StatusFlagValueIds>;
type StatusFlagState = {
  backings: Map<X86StatusFlag, FlagBacking>;
  directSource: FlagSourceId | undefined;
};

const logicUndefFlagPolicy: UndefFlagPolicy = "zero";

export class StatusFlags {
  readonly #values: ValueTable;
  readonly #pending: PendingState;
  readonly #sources: SimpleFlagSource<ValueId>[] = [];
  readonly #current = initialStatusFlagState();
  readonly #valueOps: ReturnType<typeof valueTableFlagOps>;

  constructor(values: ValueTable, pending: PendingState) {
    this.#values = values;
    this.#pending = pending;
    this.#valueOps = valueTableFlagOps(values);
  }

  readFlag(flag: X86StatusFlag): ValueId {
    return this.#resolveFlagFrom(this.#current, flag, new Map());
  }

  condition(cc: ConditionCode): ValueId {
    return this.#directCondition(cc) ?? this.#flagBoolExpr(CONDITIONS[cc].expr, new Map());
  }

  writeStatusFlagsSource(source: SimpleFlagSource<ValueId>): void {
    const sourceId = this.#sources.length;

    this.#sources.push(source);
    this.#current.directSource = sourceId;

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

  writeFlag(targetFlag: X86StatusFlag, value: ValueId): void {
    if (this.#isCurrentFlagValue(targetFlag, value)) {
      return;
    }

    this.#flushBeforeDirectFlagWrite();
    this.#writeExplicitFlag(targetFlag, value);
  }

  has(flag: X86StatusFlag): boolean {
    return getBacking(this.#current.backings, flag).kind !== "input";
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
    // otherwise later edges could mix stale explicit bytes with invalidated
    // lazy metadata.
    this.#current.directSource = undefined;
    this.#invalidateLazyChannels();
    for (const flag of x86StatusFlags) {
      this.#writeExplicitFlag(flag, values[flag]);
    }
    this.#pending.write(lazyFlagsKindChannel, this.#values.const(0));
  }

  #writeExplicitFlag(flag: X86StatusFlag, value: ValueId): void {
    this.#setBacking(flag, { kind: "value", value });
    this.#pending.write(flagChannel(flag), value);
  }

  #isCurrentFlagValue(flag: X86StatusFlag, value: ValueId): boolean {
    const backing = getBacking(this.#current.backings, flag);

    switch (backing.kind) {
      case "source":
        return this.#sourceValues(backing.source, new Map())[flag] === value;
      case "value":
        return backing.value === value;
      case "input":
        return this.#isInputFlagValue(backing.flag, value);
      case "undef":
        return backing.policy === "zero" && value === this.#values.const(0);
    }
  }

  #isInputFlagValue(flag: X86StatusFlag, value: ValueId): boolean {
    const node = this.#values.node(value);

    return node.kind === "helperCall" && node.helper.kind === "lazyFlag" && node.helper.flag === flag;
  }

  #hasInputBackings(): boolean {
    return x86StatusFlags.some((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #writeLazyBinarySource(source: SimpleFlagSource<ValueId> & Readonly<{ kind: "add" | "sub" }>): void {
    const kind = source.kind === "add" ? LAZY_FLAGS_KIND.ADD : LAZY_FLAGS_KIND.SUB;

    this.#invalidateExplicitFlagChannels();
    this.#pending.invalidate(lazyFlagsKindChannel);
    this.#pending.write(lazyFlagsAChannel, this.#values.truncate(source.width, source.left));
    this.#pending.write(lazyFlagsBChannel, this.#values.truncate(source.width, source.right));
    this.#pending.write(
      lazyFlagsKindChannel,
      this.#values.const(lazyFlagsKindByte(kind, source.width))
    );
  }

  #writeLazyLogicSource(source: SimpleFlagSource<ValueId> & Readonly<{ kind: "logic" }>): void {
    this.#invalidateExplicitFlagChannels();
    this.#pending.invalidate(lazyFlagsKindChannel);
    this.#pending.write(lazyFlagsAChannel, this.#values.truncate(source.width, source.result));
    this.#pending.invalidate(lazyFlagsBChannel);
    this.#pending.write(
      lazyFlagsKindChannel,
      this.#values.const(lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, source.width))
    );
  }

  #invalidateExplicitFlagChannels(): void {
    for (const flag of x86StatusFlags) {
      this.#pending.invalidate(flagChannel(flag));
    }
  }

  #invalidateLazyChannels(): void {
    this.#pending.invalidate(lazyFlagsAChannel);
    this.#pending.invalidate(lazyFlagsBChannel);
    this.#pending.invalidate(lazyFlagsKindChannel);
  }

  #resolveFlagFrom(
    state: StatusFlagState,
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
        return this.#compare(source.width, operator, source.left, source.right);
      case "logic":
        return this.#compare(source.width, operator, source.result, this.#values.const(0));
    }
  }

  #flagBoolExpr(expr: FlagBoolExpr, cache: SourceExpansionCache): ValueId {
    switch (expr.kind) {
      case "flag":
        return this.#resolveFlagFrom(this.#current, expr.flag, cache);
      case "not":
        return this.#values.compare(
          "eq",
          this.#flagBoolExpr(expr.value, cache),
          this.#values.const(0)
        );
      case "and":
        return this.#values.binary(
          "and",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
      case "or":
        return this.#values.binary(
          "or",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
      case "xor":
        return this.#values.binary(
          "xor",
          this.#flagBoolExpr(expr.a, cache),
          this.#flagBoolExpr(expr.b, cache)
        );
    }
  }

  #readInputFlag(flag: X86StatusFlag): ValueId {
    return this.#values.addHelperCall({ kind: "lazyFlag", flag });
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

  #compare(width: SimpleFlagSource<ValueId>["width"], operator: CompareOperator, a: ValueId, b: ValueId): ValueId {
    const lower = signedComparePredicates.has(operator)
      ? (id: ValueId) => this.#values.extend(width, id, true)
      : (id: ValueId) => this.#values.truncate(width, id);

    return this.#values.compare(operator, lower(a), lower(b));
  }
}

function initialBackings(): Map<X86StatusFlag, FlagBacking> {
  return new Map(x86StatusFlags.map((flag) => [flag, { kind: "input", flag }]));
}

function initialStatusFlagState(): StatusFlagState {
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

  assert(backing !== undefined, `missing pending backing for ${flag}`);

  return backing;
}
