import { assert } from "#common/assert.js";
import type { StorageAccess } from "#compiler/ir/effects.js";
import type { Control, ReturnControl } from "#compiler/ir/controls/index.js";
import type {
  Operation
} from "#compiler/ir/operations/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body, BodyNode, IrBlock } from "#ir/block.js";
import type {
  BodyAnalysis,
  BodyPathStep,
  BodySite,
  InvocationSite,
  JoinControlProducer,
  OperationSite,
  Producer,
  SiteId,
  ValueDemand
} from "./model.js";
import { SiteIndex } from "./sites.js";

export function analyzeBody(block: IrBlock): BodyAnalysis {
  return new BodyAnalyzer(block);
}

const noWrites: readonly StorageAccess[] = [];

type BodyWalkResult = Readonly<{
  writes: readonly StorageAccess[];
  mandatoryResult: ValueDemand | undefined;
}>;

type ControlProduction = Readonly<{
  producer: JoinControlProducer;
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
  readonly #operations: OperationSite[] = [];
  readonly #operationSet = new Set<Operation>();
  readonly #invocations: InvocationSite[] = [];
  readonly #operationByInvocationSite = new Map<
    InvocationSite,
    Operation | null
  >();

  constructor(block: IrBlock) {
    this.#block = block;
    this.#siteIndex = new SiteIndex(block.body);
    this.#useCounts = new Uint32Array(block.values.size());

    this.#walkBody(block.body);
    this.#seedRoots();
    this.#propagateUses();
    if (this.#recordRequiredOperationDemands()) {
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

  siteOf(body: Body, nodeIndex: number): SiteId {
    return this.#siteIndex.siteOf(body, nodeIndex);
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

  controlProducer(output: ValueId): JoinControlProducer | undefined {
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

  operations(): readonly OperationSite[] {
    return this.#operations;
  }

  invocations(): readonly InvocationSite[] {
    return this.#invocations;
  }

  operationMustExecute(operation: Operation): boolean {
    assert(this.#operationSet.has(operation), "operation is not part of this analysis");
    // An operation must execute when an output is used or it writes.
    return operation.outputs.some((output) => this.#useCounts[output] !== 0) ||
      operation.directEffects.writes.length !== 0;
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

  #walkBody(body: Body): BodyWalkResult {
    const bodyWrites: StorageAccess[] = [];
    let mandatoryResult: ValueDemand | undefined;

    for (const [nodeIndex, node] of body.nodes.entries()) {
      const nodeSite = this.#siteIndex.addNode(body, nodeIndex, node);

      this.#writesBySite.push(undefined);
      const demand = (value: ValueId): ValueDemand => ({
        value,
        consumedAt: nodeSite
      });
      const nodeWrites = this.#walkNode(node, nodeSite, demand);

      this.#writesBySite[nodeSite] = nodeWrites;
      bodyWrites.push(...nodeWrites);
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

  #walkNode(
    node: BodyNode,
    site: SiteId,
    demand: (value: ValueId) => ValueDemand
  ): readonly StorageAccess[] {
    if (node.category === "operation") {
      return this.#walkOperation(node, site, demand);
    }

    this.#roots.push(...node.operands.map(demand));
    if (node.kind === "return" && node.source.kind === "invocation") {
      this.#recordReturnInvocation(node, site);
    }
    const nested = node.nestedBodies;
    const bodies = nested.map((entry) => entry.body);
    const walked = nested.map((entry) =>
      this.#walkNestedBody(entry.body, site, entry.scope.kind === "loop")
    );
    const outputs = node.outputs;

    assert(outputs.length <= 1, `${node.kind} control has multiple join outputs`);
    if (outputs.length === 1) {
      this.#recordControlOutput(outputs[0]!, node, site, bodies, walked);
    }

    return mergeWrites([
      node.directEffects.writes,
      ...walked.map((result) => result.writes)
    ]);
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
    const inputs = operation.operands;
    const outputs = operation.outputs;
    const effects = operation.directEffects;

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
    control: Control,
    site: SiteId,
    bodies: readonly Body[],
    walked: readonly BodyWalkResult[]
  ): void {
    const dependencies: ValueDemand[] = [];

    for (const [index, body] of bodies.entries()) {
      const result = body.result;
      const bodyResult = walked[index];

      assert(result !== undefined, `${control.kind} arm has no result`);
      assert(bodyResult !== undefined, `${control.kind} arm was not analyzed`);
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
      producer: { site },
      dependencies
    });
  }

  #recordRequiredOperationDemands(): boolean {
    let added = false;

    for (const { operation, site } of this.#operations) {
      const outputs = operation.outputs;

      if (outputs.length === 0) {
        continue;
      }
      const effects = operation.directEffects;

      if (effects.writes.length === 0) {
        continue;
      }
      if (outputs.some((output) => this.#useCounts[output] !== 0)) {
        continue;
      }
      for (const input of operation.operands) {
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

    for (let rawId = this.#block.values.size() - 1; rawId >= 0; rawId -= 1) {
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
