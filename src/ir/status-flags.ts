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
import { createOpAction, type Action, type SwitchCase } from "./actions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "./lazy-flags.js";
import { valueTableFlagOps } from "./flag-value-ops.js";
import {
  flagChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "./slots.js";
import { fitsUnsigned, type ValueId, type ValueTable } from "./values.js";
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
type FlagBoolExprFlagResolver = (flag: X86StatusFlag) => ValueId;
type StatusFlagState = {
  backings: Map<X86StatusFlag, FlagBacking>;
  directSource: FlagSourceId | undefined;
};

const logicUndefFlagPolicy: UndefFlagPolicy = "zero";
const lazyConditionWidths = [8, 16, 32] as const;
type LazyConditionCaseSpec = Readonly<{
  kind: typeof LAZY_FLAGS_KIND.ADD | typeof LAZY_FLAGS_KIND.SUB | typeof LAZY_FLAGS_KIND.LOGIC_RESULT;
  width: (typeof lazyConditionWidths)[number];
  operator: CompareOperator;
}>;

export class StatusFlags {
  readonly #values: ValueTable;
  readonly #pending: PendingState;
  readonly #emit: (action: Action) => void;
  readonly #sources: SimpleFlagSource<ValueId>[] = [];
  readonly #current = initialStatusFlagState();
  readonly #inputFlags = new Map<X86StatusFlag, ValueId>();
  readonly #valueOps: ReturnType<typeof valueTableFlagOps>;

  constructor(values: ValueTable, pending: PendingState, emit: (action: Action) => void) {
    this.#values = values;
    this.#pending = pending;
    this.#emit = emit;
    this.#valueOps = valueTableFlagOps(values);
  }

  readFlag(flag: X86StatusFlag): ValueId {
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
    // otherwise later paths could mix stale explicit bytes with invalidated
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

  #lazyInputCondition(cc: ConditionCode): ValueId | undefined {
    const caseSpecs = lazyRuntimeConditionCaseSpecs(cc);

    if (caseSpecs.length === 0 || !this.#conditionReadsOnlyInputFlags(cc)) {
      return undefined;
    }

    const selector = this.#pending.read(lazyFlagsKindChannel);
    const cases = caseSpecs.map((spec) => this.#lazyConditionArm(spec));
    const defaultBody = this.#lazyConditionDefaultBody(CONDITIONS[cc].expr);
    const output = this.#values.addActionOutput(fitsUnsigned(1));

    this.#emit({
      kind: "switch",
      selector,
      output,
      cases,
      defaultBody
    });
    return output;
  }

  #conditionReadsOnlyInputFlags(cc: ConditionCode): boolean {
    return CONDITIONS[cc].reads.every((flag) => getBacking(this.#current.backings, flag).kind === "input");
  }

  #lazyConditionArm(spec: LazyConditionCaseSpec): SwitchCase {
    const left = createOpAction(this.#values, { kind: "state.read", slot: lazyFlagsAChannel });

    assert(left.output !== undefined, "lazy condition left read is missing its output");

    if (spec.kind === LAZY_FLAGS_KIND.LOGIC_RESULT) {
      return {
        match: lazyFlagsKindByte(spec.kind, spec.width),
        body: {
          actions: [left],
          result: this.#compare(spec.width, spec.operator, left.output, this.#values.const(0))
        }
      };
    }

    const right = createOpAction(this.#values, { kind: "state.read", slot: lazyFlagsBChannel });

    assert(right.output !== undefined, "lazy condition right read is missing its output");

    return {
      match: lazyFlagsKindByte(spec.kind, spec.width),
      body: {
        actions: [left, right],
        result: this.#compare(spec.width, spec.operator, left.output, right.output)
      }
    };
  }

  #lazyConditionDefaultBody(expr: FlagBoolExpr): Readonly<{ actions: readonly Action[]; result: ValueId }> {
    const actions: Action[] = [];
    const flags = new Map<X86StatusFlag, ValueId>();
    const result = this.#flagBoolExpr(expr, (flag) => {
      const cached = flags.get(flag);

      if (cached !== undefined) {
        return cached;
      }

      const action = createOpAction(this.#values, { kind: "cpu.resolveFlag", flag });

      assert(action.output !== undefined, `${flag} resolver is missing its output`);

      actions.push(action);
      flags.set(flag, action.output);
      return action.output;
    });

    return { actions, result };
  }

  #flagBoolExpr(expr: FlagBoolExpr, resolveFlag: FlagBoolExprFlagResolver): ValueId {
    switch (expr.kind) {
      case "flag":
        return resolveFlag(expr.flag);
      case "not":
        return this.#values.compare(
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

    const resolved = this.#pending.resolveFlag(flag);

    this.#inputFlags.set(flag, resolved);
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
