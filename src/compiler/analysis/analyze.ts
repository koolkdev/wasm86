import { assert } from "#common/assert.js";
import type {
  StorageEffects,
  StorageAccess
} from "#compiler/ir/effects.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  bodyFinal,
  type Action,
  type CallAction,
  type IfAction,
  type OpAction,
  type SwitchAction
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { actionOutput, finishOperands } from "#ir/traverse.js";
import type {
  BodyAnalysis,
  BodyPathStep,
  BodySite,
  CallSite,
  ControlProducer,
  OperationSite,
  ProducingAction,
  Producer,
  SiteId,
  ValueDemand
} from "./model.js";
import { SiteIndex } from "./sites.js";

export function analyzeBody(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): BodyAnalysis {
  return new BodyAnalyzer(block, exportedOutputs);
}

const noWrites: readonly StorageAccess[] = [];

type BodyWalkResult = Readonly<{
  writes: readonly StorageAccess[];
  mandatoryResult: ValueDemand | undefined;
}>;

type ControlProduction = Readonly<{
  producer: ControlProducer;
  dependencies: readonly ValueDemand[];
}>;

class BodyAnalyzer implements BodyAnalysis {
  readonly #block: IrBlock;
  readonly #siteIndex: SiteIndex;
  readonly #writesBySite: (readonly StorageAccess[] | undefined)[] = [];

  readonly #roots: ValueDemand[] = [];
  readonly #producers = new Map<ValueId, Producer>();
  readonly #controlProductions = new Map<ValueId, ControlProduction>();

  readonly #useCounts: Uint32Array;
  readonly #exportedOutputs: ValueId[];

  readonly #operations: OperationSite[] = [];
  readonly #operationActions = new Set<OpAction>();
  readonly #calls: CallSite[] = [];
  readonly #callActions = new Set<CallAction>();

  constructor(
    block: IrBlock,
    exportedOutputs: Iterable<ValueId>
  ) {
    this.#block = block;
    this.#siteIndex = new SiteIndex(block.body);
    this.#useCounts = new Uint32Array(block.values.size());
    this.#exportedOutputs = [...exportedOutputs];

    this.#walkBody(block.body);
    this.#recordExportDemands();
    this.#seedRoots();
    this.#propagateUses();
    if (this.#recordRequiredCallDemands()) {
      this.#useCounts.fill(0);
      this.#seedRoots();
      this.#propagateUses();
    }

    assert(
      this.#writesBySite.length === this.#siteIndex.sites().length &&
        this.#writesBySite.every((writes) => writes !== undefined),
      "body analysis did not record writes for every site"
    );
  }

  sites(): readonly BodySite[] {
    return this.#siteIndex.sites();
  }

  siteOf(body: Body, actionIndex: number): SiteId {
    return this.#siteIndex.siteOf(body, actionIndex);
  }

  path(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined {
    return this.#siteIndex.path(ancestor, descendant);
  }

  isLoopBody(body: Body): boolean {
    return this.#siteIndex.isLoopBody(body);
  }

  dominatingSite(sites: readonly SiteId[]): SiteId {
    return this.#siteIndex.dominatingSite(sites);
  }

  bodyEndSite(body: Body): SiteId {
    return this.#siteIndex.bodyEndSite(body);
  }

  roots(): readonly ValueDemand[] {
    return this.#roots;
  }

  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined {
    this.#block.values.node(output);
    return this.#controlProductions.get(output)?.dependencies;
  }

  controlProducer(output: ValueId): ControlProducer | undefined {
    this.#block.values.node(output);
    return this.#controlProductions.get(output)?.producer;
  }

  producer(output: ValueId): Producer | undefined {
    this.#block.values.node(output);
    return this.#producers.get(output);
  }

  isLive(id: ValueId): boolean {
    this.#block.values.node(id);
    return this.#useCounts[id] !== 0;
  }

  useCount(id: ValueId): number {
    this.#block.values.node(id);
    return this.#useCounts[id] ?? 0;
  }

  writesAt(site: SiteId): readonly StorageAccess[] {
    this.#siteIndex.site(site);
    const writes = this.#writesBySite[site];

    assert(writes !== undefined, `site ${site} has no writes`);
    return writes;
  }

  exportedOutputs(): readonly ValueId[] {
    return this.#exportedOutputs;
  }

  operations(): readonly OperationSite[] {
    return this.#operations;
  }

  calls(): readonly CallSite[] {
    return this.#calls;
  }

  actionEffects(action: ProducingAction): StorageEffects {
    switch (action.kind) {
      case "op":
        assert(this.#operationActions.has(action), "operation action is not part of this analysis");
        return action.op.effects;
      case "call":
        assert(this.#callActions.has(action), "call action is not part of this analysis");
        return action.target.effects;
    }
  }

  actionMustExecute(action: ProducingAction): boolean {
    const output = actionOutput(action);

    if (output !== undefined && this.#useCounts[output] !== 0) {
      return true;
    }
    switch (action.kind) {
      case "op":
        assert(this.#operationActions.has(action), "operation action is not part of this analysis");
        return output === undefined;
      case "call":
        assert(this.#callActions.has(action), "call action is not part of this analysis");
        return action.target.effects.writes.length !== 0;
    }
  }

  opActionMustExecute(action: OpAction): boolean {
    return this.actionMustExecute(action);
  }

  callActionMustExecute(action: CallAction): boolean {
    return this.actionMustExecute(action);
  }

  #walkBody(body: Body): BodyWalkResult {
    const bodyWrites: StorageAccess[] = [];
    let mandatoryResult: ValueDemand | undefined;

    for (const [actionIndex, action] of body.actions.entries()) {
      const actionSite = this.#siteIndex.addAction(body, actionIndex, action);

      this.#writesBySite.push(undefined);
      const demand = (value: ValueId): ValueDemand => ({
        value,
        consumedAt: actionSite
      });
      const actionWrites = this.#walkAction(action, actionSite, demand);

      this.#writesBySite[actionSite] = actionWrites;
      bodyWrites.push(...actionWrites);
    }

    const endSite = this.#siteIndex.addEnd(body);

    this.#writesBySite.push(noWrites);

    if (
      body.result !== undefined &&
      this.#block.values.isUnreachable(body.result)
    ) {
      mandatoryResult = {
        value: body.result,
        consumedAt: endSite
      };

      this.#roots.push(mandatoryResult);
    }

    return {
      writes: bodyWrites,
      mandatoryResult
    };
  }

  #walkAction(
    action: Action,
    site: SiteId,
    demand: (value: ValueId) => ValueDemand
  ): readonly StorageAccess[] {
    switch (action.kind) {
      case "op": {
        this.#operations.push({ action, site });
        this.#operationActions.add(action);
        const inputs = action.op.inputs.map((input) => input.value);
        const output = actionOutput(action);

        if (output === undefined) {
          this.#roots.push(...inputs.map(demand));
          return action.op.effects.writes;
        }

        assert(
          !this.#producers.has(output) && !this.#controlProductions.has(output),
          `value ${output} already has a producer`
        );
        this.#producers.set(output, { output, action, site, inputs });

        return action.op.effects.writes;
      }
      case "call": {
        this.#calls.push({ action, site });
        this.#callActions.add(action);
        const inputs = action.arguments.map((argument) => argument.value);
        const output = actionOutput(action);
        const effects = action.target.effects;

        if (output === undefined) {
          return effects.writes;
        }

        assert(
          !this.#producers.has(output) && !this.#controlProductions.has(output),
          `value ${output} already has a producer`
        );
        this.#producers.set(output, { output, action, site, inputs });
        return effects.writes;
      }
      case "if": {
        this.#roots.push(demand(action.condition));
        const bodies = action.elseBody === undefined
          ? [action.thenBody]
          : [action.thenBody, action.elseBody];
        const walked = bodies.map((body) =>
          this.#walkNestedBody(body, site)
        );

        if (action.output !== undefined) {
          this.#recordControlOutput(action.output, action, site, bodies, walked);
        }

        return mergeWrites(walked.map((result) => result.writes));
      }
      case "switch": {
        this.#roots.push(demand(action.selector));
        const bodies = [...action.cases.map((switchCase) => switchCase.body), action.defaultBody];
        const walked = bodies.map((body) =>
          this.#walkNestedBody(body, site)
        );

        this.#recordControlOutput(action.output, action, site, bodies, walked);
        return mergeWrites(walked.map((result) => result.writes));
      }
      case "loop": {
        for (const cell of action.carried) {
          this.#roots.push(demand(cell.seed));
        }

        const walked = this.#walkNestedBody(
          action.body,
          site,
          true
        );

        return walked.writes;
      }
      case "loopContinue":
        this.#roots.push(...action.updates.map(demand));
        return noWrites;
      case "finish":
        this.#roots.push(...finishOperands(action.finish).map(demand));
        return noWrites;
      case "return":
        this.#roots.push(...action.results.map(demand));
        return noWrites;
    }
  }

  #walkNestedBody(
    body: Body,
    owner: SiteId,
    isLoop = false
  ): BodyWalkResult {
    this.#siteIndex.registerNested(body, owner, isLoop);
    return this.#walkBody(body);
  }

  #recordControlOutput(
    output: ValueId,
    action: IfAction | SwitchAction,
    site: SiteId,
    bodies: readonly Body[],
    walked: readonly BodyWalkResult[]
  ): void {
    const dependencies: ValueDemand[] = [];

    for (const [index, body] of bodies.entries()) {
      const result = body.result;
      const bodyResult = walked[index];

      assert(result !== undefined, `${action.kind} arm has no result`);
      assert(bodyResult !== undefined, `${action.kind} arm was not analyzed`);
      const end = this.bodyEndSite(body);
      const mandatory = bodyResult.mandatoryResult;

      if (mandatory !== undefined) {
        assert(mandatory.value === result, "mandatory body result has the wrong value");
        dependencies.push(mandatory);
      } else {
        dependencies.push({
          value: result,
          consumedAt: end
        });
      }
    }

    assert(
      !this.#producers.has(output) && !this.#controlProductions.has(output),
      `value ${output} already has a control producer`
    );
    this.#controlProductions.set(output, {
      producer: { action, site },
      dependencies
    });
  }

  #recordExportDemands(): void {
    const body = this.#block.body;
    const lastActionIndex = body.actions.length - 1;
    const site = bodyFinal(body) === undefined
      ? this.bodyEndSite(body)
      : this.siteOf(body, lastActionIndex);

    for (const output of this.#exportedOutputs) {
      this.#roots.push({ value: output, consumedAt: site });
    }
  }

  #recordRequiredCallDemands(): boolean {
    let added = false;

    for (const { action, site } of this.#calls) {
      const effects = action.target.effects;

      if (effects.writes.length === 0) {
        continue;
      }
      const output = actionOutput(action);

      if (output !== undefined && this.#useCounts[output] !== 0) {
        continue;
      }
      for (const argument of action.arguments) {
        this.#roots.push({ value: argument.value, consumedAt: site });
        added = true;
      }
    }
    return added;
  }

  #seedRoots(): void {
    for (const root of this.#roots) {
      this.#addUse(root.value);
    }
  }

  // Value construction and IR validation give dependencies a lower id than
  // their parent. One descending pass therefore settles both reachability and
  // concrete semantic uses.
  #propagateUses(): void {
    for (let rawId = this.#block.values.size() - 1; rawId >= 0; rawId -= 1) {
      const id = valueId(rawId);

      if (this.#useCounts[id] === 0) {
        continue;
      }

      const producer = this.#producers.get(id);

      if (producer !== undefined) {
        for (const dependency of producer.inputs) {
          this.#addUse(dependency);
        }
        continue;
      }
      const control = this.#controlProductions.get(id);

      if (control !== undefined) {
        // An unreachable arm result is an execution requirement in its own
        // right. Its body-end root is also the selected arm's only realization,
        // so a live join must not count a second use of the same occurrence.
        for (const dependency of control.dependencies) {
          if (!this.#block.values.isUnreachable(dependency.value)) {
            this.#addUse(dependency.value);
          }
        }
        continue;
      }

      for (const dependency of this.#block.values.children(id)) {
        this.#addUse(dependency);
      }
    }
  }

  #addUse(id: ValueId): void {
    this.#block.values.node(id);
    this.#useCounts[id] = (this.#useCounts[id] ?? 0) + 1;
  }
}

function mergeWrites(groups: readonly (readonly StorageAccess[])[]): readonly StorageAccess[] {
  const writes: StorageAccess[] = [];

  for (const group of groups) {
    writes.push(...group);
  }

  return writes;
}
