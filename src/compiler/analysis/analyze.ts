import { assert } from "#common/assert.js";
import type { StorageAccess } from "#compiler/ir/operations/definition.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  bodyFinal,
  type Action,
  type IfAction,
  type OpAction,
  type SwitchAction
} from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { actionOutput, valueDependsOn } from "#ir/traverse.js";
import type {
  BodyAnalysis,
  BodyPathStep,
  BodySite,
  ControlProducer,
  OperationSite,
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
  produced: ReadonlySet<ValueId>;
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

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#block = block;
    this.#siteIndex = new SiteIndex(block.body);
    this.#useCounts = new Uint32Array(block.values.size());
    this.#exportedOutputs = [...exportedOutputs];

    this.#walkBody(block.body, undefined, []);
    this.#recordExportDemands();
    this.#seedRoots();
    this.#propagateUses();

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

  opActionMustExecute(action: OpAction): boolean {
    assert(this.#operationActions.has(action), "operation action is not part of this analysis");
    const output = actionOutput(action);

    return output === undefined || this.#useCounts[output] !== 0;
  }

  #walkBody(
    body: Body,
    ownerSite: SiteId | undefined,
    initiallyProduced: readonly ValueId[]
  ): BodyWalkResult {
    const produced = new Set(initiallyProduced);
    const bodyWrites: StorageAccess[] = [];
    let mandatoryResult: ValueDemand | undefined;

    for (const [actionIndex, action] of body.actions.entries()) {
      const actionSite = this.#siteIndex.addAction(body, actionIndex, action);

      this.#writesBySite.push(undefined);
      const demand = (value: ValueId): ValueDemand => ({
        value,
        requiredAt:
          ownerSite === undefined ||
          produced.has(value) ||
          valueDependsOn(this.#block.values, value, produced)
            ? actionSite
            : ownerSite,
        consumedAt: actionSite
      });
      const actionWrites = this.#walkAction(action, actionSite, demand, produced);

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
        requiredAt: endSite,
        consumedAt: endSite
      };

      this.#roots.push(mandatoryResult);
    }

    return {
      writes: bodyWrites,
      produced,
      mandatoryResult
    };
  }

  #walkAction(
    action: Action,
    site: SiteId,
    demand: (value: ValueId) => ValueDemand,
    produced: Set<ValueId>
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
        produced.add(output);

        return action.op.effects.writes;
      }
      case "if": {
        this.#roots.push(demand(action.condition));
        const bodies = action.elseBody === undefined
          ? [action.thenBody]
          : [action.thenBody, action.elseBody];
        const walked = bodies.map((body) =>
          this.#walkNestedBody(body, site, [])
        );

        if (action.output !== undefined) {
          this.#recordControlOutput(action.output, action, site, bodies, walked, produced);
        }

        return mergeWrites(walked.map((result) => result.writes));
      }
      case "switch": {
        this.#roots.push(demand(action.selector));
        const bodies = [...action.cases.map((switchCase) => switchCase.body), action.defaultBody];
        const walked = bodies.map((body) =>
          this.#walkNestedBody(body, site, [])
        );

        this.#recordControlOutput(action.output, action, site, bodies, walked, produced);
        return mergeWrites(walked.map((result) => result.writes));
      }
      case "loop": {
        for (const cell of action.carried) {
          this.#roots.push(demand(cell.seed));
        }

        const walked = this.#walkNestedBody(
          action.body,
          site,
          action.carried.map((cell) => cell.loopInput),
          true
        );

        return walked.writes;
      }
      case "loopContinue":
        this.#roots.push(...action.updates.map(demand));
        return noWrites;
      case "finish":
        switch (action.finish.kind) {
          case "exit":
            // An exit result is required at its terminal action.
            this.#roots.push({
              value: action.finish.result,
              requiredAt: site,
              consumedAt: site
            });
            return noWrites;
          case "dispatch":
            this.#roots.push(demand(action.finish.targetEip));
            return noWrites;
        }
    }
  }

  #walkNestedBody(
    body: Body,
    owner: SiteId,
    initiallyProduced: readonly ValueId[],
    isLoop = false
  ): BodyWalkResult {
    this.#siteIndex.registerNested(body, owner, isLoop);
    return this.#walkBody(body, owner, initiallyProduced);
  }

  #recordControlOutput(
    output: ValueId,
    action: IfAction | SwitchAction,
    site: SiteId,
    bodies: readonly Body[],
    walked: readonly BodyWalkResult[],
    produced: Set<ValueId>
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
          requiredAt: valueDependsOn(this.#block.values, result, bodyResult.produced)
            ? end
            : site,
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
    produced.add(output);
  }

  #recordExportDemands(): void {
    const body = this.#block.body;
    const lastActionIndex = body.actions.length - 1;
    const site = bodyFinal(body) === undefined
      ? this.bodyEndSite(body)
      : this.siteOf(body, lastActionIndex);

    for (const output of this.#exportedOutputs) {
      this.#roots.push({ value: output, requiredAt: site, consumedAt: site });
    }
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
