import { assert } from "#common/assert.js";
import type { StorageAccess } from "#compiler/ir/effects.js";
import type { Control, ReturnControl } from "#compiler/ir/controls/index.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import { describeNode } from "#compiler/ir/node.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region, RegionNode } from "#compiler/ir/region.js";
import type { Function as IrFunction } from "#compiler/wasm/legacy/function.js";
import type {
  FunctionAnalysis,
  RegionPathStep,
  RegionSite,
  InvocationSite,
  JoinControlProducer,
  OperationSite,
  Producer,
  SiteId,
  ValueDemand
} from "./model.js";
import { FunctionGeometry } from "./geometry.js";

export function analyzeFunction(fn: IrFunction): FunctionAnalysis {
  return new FunctionAnalyzer(fn);
}

const noWrites: readonly StorageAccess[] = [];

type RegionWalkResult = Readonly<{
  writes: readonly StorageAccess[];
  mandatoryResult: ValueDemand | undefined;
}>;

type ControlProduction = Readonly<{
  producer: JoinControlProducer;
  dependencies: readonly ValueDemand[];
}>;

class FunctionAnalyzer implements FunctionAnalysis {
  readonly #function: IrFunction;
  readonly #geometry: FunctionGeometry;
  readonly #writesBySite: (readonly StorageAccess[] | undefined)[] = [];

  readonly #roots: ValueDemand[] = [];
  readonly #producers = new Map<ValueId, Producer>();
  readonly #controlProductions = new Map<ValueId, ControlProduction>();

  readonly #useCounts: Uint32Array;
  readonly #operations: OperationSite[] = [];
  readonly #operationSet = new Set<Operation>();
  readonly #invocations: InvocationSite[] = [];
  readonly #operationByInvocationSite = new Map<InvocationSite, Operation | null>();

  constructor(fn: IrFunction) {
    this.#function = fn;
    this.#geometry = new FunctionGeometry(fn.body);
    this.#useCounts = new Uint32Array(fn.values.size());

    this.#walkRegion(fn.body);
    this.#seedRoots();
    this.#propagateUses();
    if (this.#recordRequiredOperationDemands()) {
      this.#useCounts.fill(0);
      this.#seedRoots();
      this.#propagateUses();
    }

    assert(
      this.#writesBySite.length === this.#geometry.sites().length &&
        this.#writesBySite.every((writes) => writes !== undefined),
      "function analysis did not record writes for every site"
    );
  }

  sites(): readonly RegionSite[] {
    return this.#geometry.sites();
  }

  siteOf(region: Region, nodeIndex: number): SiteId {
    return this.#geometry.siteOf(region, nodeIndex);
  }

  path(ancestor: Region, descendant: Region): readonly RegionPathStep[] | undefined {
    return this.#geometry.path(ancestor, descendant);
  }

  isLoopRegion(region: Region): boolean {
    return this.#geometry.isLoopRegion(region);
  }

  dominatingSite(sites: readonly SiteId[]): SiteId {
    return this.#geometry.dominatingSite(sites);
  }

  regionEndSite(region: Region): SiteId {
    return this.#geometry.regionEndSite(region);
  }

  roots(): readonly ValueDemand[] {
    return this.#roots;
  }

  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined {
    this.#function.values.node(output);
    return this.#controlProductions.get(output)?.dependencies;
  }

  controlProducer(output: ValueId): JoinControlProducer | undefined {
    this.#function.values.node(output);
    return this.#controlProductions.get(output)?.producer;
  }

  producer(output: ValueId): Producer | undefined {
    this.#function.values.node(output);
    return this.#producers.get(output);
  }

  isLive(id: ValueId): boolean {
    this.#function.values.node(id);
    return this.#useCounts[id] !== 0;
  }

  useCount(id: ValueId): number {
    this.#function.values.node(id);
    return this.#useCounts[id] ?? 0;
  }

  writesAt(site: SiteId): readonly StorageAccess[] {
    this.#geometry.site(site);
    const writes = this.#writesBySite[site];

    assert(writes !== undefined, `site ${site} has no writes`);
    return writes;
  }

  operations(): readonly OperationSite[] {
    return this.#operations;
  }

  invocations(): readonly InvocationSite[] {
    return this.#invocations;
  }

  operationMustExecute(operation: Operation): boolean {
    assert(this.#operationSet.has(operation), "operation is not part of this analysis");
    const description = describeNode(operation);

    // An operation must execute when an output is used or it writes.
    return (
      description.outputs.some((output) => this.#useCounts[output] !== 0) ||
      description.effects.writes.length !== 0
    );
  }

  invocationMustExecute(site: InvocationSite): boolean {
    assert(
      this.#operationByInvocationSite.has(site),
      "invocation site is not part of this analysis"
    );
    const operation = this.#operationByInvocationSite.get(site);

    assert(operation !== undefined, "invocation site has no owner");
    return operation === null || this.operationMustExecute(operation);
  }

  #walkRegion(region: Region): RegionWalkResult {
    const regionWrites: StorageAccess[] = [];
    let mandatoryResult: ValueDemand | undefined;

    for (const [nodeIndex, node] of region.nodes.entries()) {
      const nodeSite = this.#geometry.addNode(region, nodeIndex, node);

      this.#writesBySite.push(undefined);
      const demand = (value: ValueId): ValueDemand => ({
        value,
        consumedAt: nodeSite
      });
      const nodeWrites = this.#walkNode(node, nodeSite, demand);

      this.#writesBySite[nodeSite] = nodeWrites;
      regionWrites.push(...nodeWrites);
    }

    const endSite = this.#geometry.addEnd(region);

    this.#writesBySite.push(noWrites);

    if (region.result !== undefined && this.#function.values.isUnreachable(region.result)) {
      mandatoryResult = {
        value: region.result,
        consumedAt: endSite
      };

      this.#roots.push(mandatoryResult);
    }

    return {
      writes: regionWrites,
      mandatoryResult
    };
  }

  #walkNode(
    node: RegionNode,
    site: SiteId,
    demand: (value: ValueId) => ValueDemand
  ): readonly StorageAccess[] {
    if (node.category === "operation") {
      return this.#walkOperation(node, site, demand);
    }

    const description = describeNode(node);

    this.#roots.push(...description.operands.map(demand));
    if (node.kind === "return" && node.source.kind === "invocation") {
      this.#recordReturnInvocation(node, site);
    }
    const nested = description.nestedBodies;
    const regions = nested.map((entry) => entry.body);
    const walked = nested.map((entry) =>
      this.#walkNestedRegion(entry.body, site, entry.scope.kind === "loop")
    );
    const outputs = description.outputs;

    assert(outputs.length <= 1, `${node.kind} control has multiple join outputs`);
    if (outputs.length === 1) {
      this.#recordControlOutput(outputs[0]!, node, site, regions, walked);
    }

    return mergeWrites([description.effects.writes, ...walked.map((result) => result.writes)]);
  }

  #walkOperation(
    operation: Operation,
    site: SiteId,
    demand: (value: ValueId) => ValueDemand
  ): readonly StorageAccess[] {
    this.#operations.push({ operation, site });
    this.#operationSet.add(operation);
    if (operation.kind === "call") {
      const invocationSite: InvocationSite = {
        invocation: operation.invocation,
        site
      };

      this.#invocations.push(invocationSite);
      this.#operationByInvocationSite.set(invocationSite, operation);
    }
    const description = describeNode(operation);
    const inputs = description.operands;
    const outputs = description.outputs;
    const effects = description.effects;

    if (outputs.length === 0 && effects.writes.length !== 0) {
      this.#roots.push(...inputs.map(demand));
    }
    for (const output of outputs) {
      assert(
        !this.#producers.has(output) && !this.#controlProductions.has(output),
        `value ${output} already has a producer`
      );
      this.#producers.set(output, { output, operation, site, inputs });
    }
    return effects.writes;
  }

  #recordReturnInvocation(control: ReturnControl, site: SiteId): void {
    assert(control.source.kind === "invocation", "return has no invocation");
    const invocationSite: InvocationSite = {
      invocation: control.source.invocation,
      site
    };

    this.#invocations.push(invocationSite);
    this.#operationByInvocationSite.set(invocationSite, null);
  }

  #walkNestedRegion(region: Region, owner: SiteId, isLoop = false): RegionWalkResult {
    this.#geometry.registerNested(region, owner, isLoop);
    return this.#walkRegion(region);
  }

  #recordControlOutput(
    output: ValueId,
    control: Control,
    site: SiteId,
    regions: readonly Region[],
    walked: readonly RegionWalkResult[]
  ): void {
    const dependencies: ValueDemand[] = [];

    for (const [index, region] of regions.entries()) {
      const result = region.result;
      const regionResult = walked[index];

      assert(result !== undefined, `${control.kind} arm has no result`);
      assert(regionResult !== undefined, `${control.kind} arm was not analyzed`);
      const end = this.regionEndSite(region);
      const mandatory = regionResult.mandatoryResult;

      if (mandatory !== undefined) {
        assert(mandatory.value === result, "mandatory region result has the wrong value");
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
      producer: { site },
      dependencies
    });
  }

  #recordRequiredOperationDemands(): boolean {
    let added = false;

    for (const { operation, site } of this.#operations) {
      const description = describeNode(operation);
      const outputs = description.outputs;

      if (outputs.length === 0) {
        continue;
      }
      const effects = description.effects;

      if (effects.writes.length === 0) {
        continue;
      }
      if (outputs.some((output) => this.#useCounts[output] !== 0)) {
        continue;
      }
      for (const input of description.operands) {
        this.#roots.push({ value: input, consumedAt: site });
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
    const propagatedOperations = new Set<Operation>();

    for (let rawId = this.#function.values.size() - 1; rawId >= 0; rawId -= 1) {
      const id = valueId(rawId);

      if (this.#useCounts[id] === 0) {
        continue;
      }

      const producer = this.#producers.get(id);

      if (producer !== undefined) {
        if (!propagatedOperations.has(producer.operation)) {
          propagatedOperations.add(producer.operation);
          for (const dependency of producer.inputs) {
            this.#addUse(dependency);
          }
        }
        continue;
      }
      const control = this.#controlProductions.get(id);

      if (control !== undefined) {
        // An unreachable arm result is an execution requirement in its own
        // right. Its region-end root is also the selected arm's only realization,
        // so a live join must not count a second use of the same occurrence.
        for (const dependency of control.dependencies) {
          if (!this.#function.values.isUnreachable(dependency.value)) {
            this.#addUse(dependency.value);
          }
        }
        continue;
      }

      for (const dependency of this.#function.values.children(id)) {
        this.#addUse(dependency);
      }
    }
  }

  #addUse(id: ValueId): void {
    this.#function.values.node(id);
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
