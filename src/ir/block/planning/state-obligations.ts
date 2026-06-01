import type { BlockActionSite } from "#ir/block/timeline.js";
import { flagMaterializationWrites } from "#ir/block/state/flag-materialization.js";
import { RegisterState } from "#ir/block/state/register-state.js";
import {
  registerMaterializationWrites
} from "#ir/block/state/register-state.js";
import type {
  FlagStateTarget,
  RegisterStateTarget
} from "#ir/block/state/targets.js";
import type { BlockExit } from "#ir/block/exits.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { BlockState } from "#ir/block/walk/state.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import type {
  Path,
  ProgramPoint,
  TimelineGeometry
} from "./geometry/index.js";

export type StateObligationId = number & { readonly __stateObligationId: unique symbol };

export type StateObligations = Readonly<{
  obligations: readonly StateObligation[];
}>;

export type StateObligation = Readonly<{
  id: StateObligationId;
  point: ProgramPoint;
  write: StateMaterializationWrite;
  reason:
    | "exit-state"
    | "dynamic-register-store-pre-state";
}>;

export type RegisterStateMaterializationWrite = Readonly<{
  target: RegisterStateTarget;
  value: ExprRef;
}>;

export type FlagStateMaterializationWrite = Readonly<{
  target: FlagStateTarget;
  value: ExprRef | undefined;
}>;

export type StateMaterializationWrite =
  | RegisterStateMaterializationWrite
  | FlagStateMaterializationWrite;

export type StateObligationInput = Readonly<{
  walked: WalkedBlock;
  geometry: TimelineGeometry;
}>;

class StateObligationIds {
  #next = 0;

  next(): StateObligationId {
    const id = this.#next;

    this.#next += 1;
    return id as StateObligationId;
  }
}

export function analyzeStateObligations(input: StateObligationInput): StateObligations {
  return new StateObligationAnalyzer(input).analyze();
}

class StateObligationAnalyzer {
  readonly #walked: WalkedBlock;
  readonly #geometry: TimelineGeometry;
  readonly #ids = new StateObligationIds();
  readonly #obligations: StateObligation[] = [];
  readonly #baselineByPath = new Map<Path, BlockState>();

  constructor(input: StateObligationInput) {
    this.#walked = input.walked;
    this.#geometry = input.geometry;
    this.#baselineByPath.set(input.geometry.paths.root, input.walked.entry);
  }

  analyze(): StateObligations {
    for (const site of this.#walked.timeline) {
      const sitePoints = this.#geometry.points.bySite.get(site);

      if (sitePoints === undefined) {
        throw new Error("timeline geometry is missing points for a walked timeline site");
      }

      switch (site.kind) {
        case "definition":
          break;
        case "action": {
          const baseline = this.#baselineForPath(sitePoints.at.path);

          switch (site.action.kind) {
            case "dynamicRegisterStore":
              this.#addDynamicRegisterStoreObligations(baseline, site.action.stateBefore, sitePoints);
              break;
            case "memoryStore":
              break;
            case "memoryGuard":
              this.#addExitStateObligations(site, site.action.faultExit, baseline);
              break;
            case "jump":
            case "hostTrap":
            case "fallthrough":
              this.#addExitStateObligations(site, site.action.exit, baseline);
              break;
            case "branch":
              this.#addExitStateObligations(site, site.action.taken, baseline);
              this.#addExitStateObligations(site, site.action.notTaken, baseline);
              break;
          }
          break;
        }
      }
    }

    return Object.freeze({
      obligations: Object.freeze([...this.#obligations])
    });
  }

  #addDynamicRegisterStoreObligations(
    baseline: BlockState,
    stateBefore: BlockState,
    sitePoints: Readonly<{ before: ProgramPoint; after: ProgramPoint }>
  ): void {
    this.#addRegisterStateObligations({
      baseline,
      snapshot: stateBefore,
      point: sitePoints.before,
      reason: "dynamic-register-store-pre-state"
    });
    this.#baselineByPath.set(
      sitePoints.after.path,
      baselineAfterDynamicRegisterStore(baseline)
    );
  }

  #addExitStateObligations(
    site: BlockActionSite,
    exit: BlockExit,
    baseline: BlockState
  ): void {
    const exitPoint = this.#geometry.exits.byExit.get(exit.id);

    if (exitPoint === undefined) {
      throw new Error(`timeline geometry is missing exit point ${exit.id}`);
    }

    if (exitPoint.sourceSite !== site) {
      throw new Error(`timeline geometry exit point ${exit.id} is attached to the wrong site`);
    }

    this.#baselineByPath.set(exitPoint.path, baseline);
    this.#addStateObligations({
      baseline: this.#baselineForPath(exitPoint.path),
      snapshot: exit.snapshot,
      point: exitPoint.point,
      reason: "exit-state"
    });
  }

  #addStateObligations(input: Readonly<{
    baseline: BlockState;
    snapshot: BlockState;
    point: ProgramPoint;
    reason: StateObligation["reason"];
  }>): void {
    for (const write of stateMaterializationWrites(input.baseline, input.snapshot)) {
      this.#obligations.push(Object.freeze({
        id: this.#ids.next(),
        point: input.point,
        write,
        reason: input.reason
      } satisfies StateObligation));
    }
  }

  #addRegisterStateObligations(input: Readonly<{
    baseline: BlockState;
    snapshot: BlockState;
    point: ProgramPoint;
    reason: StateObligation["reason"];
  }>): void {
    for (const write of registerStateMaterializationWrites(input.baseline, input.snapshot)) {
      this.#obligations.push(Object.freeze({
        id: this.#ids.next(),
        point: input.point,
        write,
        reason: input.reason
      } satisfies StateObligation));
    }
  }

  #baselineForPath(path: Path): BlockState {
    const direct = this.#baselineByPath.get(path);

    if (direct !== undefined) {
      return direct;
    }

    const parent = this.#geometry.paths.parentByPath.get(path);

    if (parent === undefined) {
      throw new Error("no path-local state baseline is available for program point path");
    }

    return this.#baselineForPath(parent);
  }
}

function stateMaterializationWrites(
  baseline: BlockState,
  snapshot: BlockState
): readonly StateMaterializationWrite[] {
  return Object.freeze([
    ...registerStateMaterializationWrites(baseline, snapshot),
    ...flagMaterializationWrites(baseline.flags, snapshot.flags)
      .map((write) => flagStateMaterializationWrite(write.flag, write.value))
  ]);
}

function registerStateMaterializationWrites(
  baseline: BlockState,
  snapshot: BlockState
): readonly StateMaterializationWrite[] {
  return Object.freeze(
    registerMaterializationWrites(baseline.registers, snapshot.registers)
      .map((write) => registerStateMaterializationWrite(write.reg, write.value))
  );
}

function registerStateMaterializationWrite(
  reg: RegisterStateTarget["reg"],
  value: ExprRef
): StateMaterializationWrite {
  return Object.freeze({
    target: Object.freeze({
      kind: "reg",
      reg
    } satisfies RegisterStateTarget),
    value
  } satisfies StateMaterializationWrite);
}

function flagStateMaterializationWrite(
  flag: FlagStateTarget["flag"],
  value: ExprRef | undefined
): StateMaterializationWrite {
  return Object.freeze({
    target: Object.freeze({
      kind: "flag",
      flag
    } satisfies FlagStateTarget),
    value
  } satisfies StateMaterializationWrite);
}

function baselineAfterDynamicRegisterStore(baseline: BlockState): BlockState {
  // The dynamic store has already mutated the architectural register file, so
  // only the register-domain visible baseline advances to the walker's barrier.
  return baseline.withRegisters(RegisterState.initial());
}
