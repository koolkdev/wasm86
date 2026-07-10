import { assert } from "#common/assert.js";
import { bodyFinal, type OpAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import {
  actionOutput,
  bodyProducedOutputs,
  finishOperands,
  loopInputsOf,
  nestedBodies,
  valueDependsOn
} from "#ir/traverse.js";
import type { ValueId } from "#ir/values.js";

export type ScheduleSite = Readonly<{
  body: Body;
  actionIndex: number;
}>;

export type BodyPathStep = Readonly<{
  body: Body;
  owner: ScheduleSite;
}>;

export type ValueDemand = Readonly<{
  value: ValueId;
  requiredAt: ScheduleSite;
  consumedAt: ScheduleSite;
}>;

export type Producer = Readonly<{
  output: ValueId;
  action: OpAction;
  site: ScheduleSite;
  inputs: readonly ValueId[];
}>;

export type DemandAnalysis = Readonly<{
  roots(): readonly ValueDemand[];
  producers(): readonly Producer[];
  producer(output: ValueId): Producer | undefined;
  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined;
  owner(body: Body): ScheduleSite | undefined;
  isLoopBody(body: Body): boolean;
  isWithin(body: Body, ancestor: Body): boolean;
  pathFrom(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined;
  dominatingSite(sites: readonly ScheduleSite[]): ScheduleSite;
}>;

export function analyzeDemands(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): DemandAnalysis {
  return new DemandAnalyzer(block, exportedOutputs);
}

class DemandAnalyzer implements DemandAnalysis {
  readonly #block: IrBlock;
  readonly #roots: ValueDemand[] = [];
  readonly #producers = new Map<ValueId, Producer>();
  readonly #controlDependencies = new Map<ValueId, readonly ValueDemand[]>();
  readonly #owners = new Map<Body, ScheduleSite>();
  readonly #ancestry = new Map<Body, readonly Body[]>();
  readonly #loopBodies = new Set<Body>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#block = block;
    this.#ancestry.set(block.body, [block.body]);
    this.#recordOwners(block.body);
    this.#recordBody(block.body);
    this.#recordExports(block.body, exportedOutputs);
  }

  roots(): readonly ValueDemand[] {
    return this.#roots;
  }

  producers(): readonly Producer[] {
    return [...this.#producers.values()];
  }

  producer(output: ValueId): Producer | undefined {
    this.#block.values.node(output);
    return this.#producers.get(output);
  }

  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined {
    this.#block.values.node(output);
    return this.#controlDependencies.get(output);
  }

  owner(body: Body): ScheduleSite | undefined {
    return this.#owners.get(body);
  }

  isLoopBody(body: Body): boolean {
    return this.#loopBodies.has(body);
  }

  isWithin(body: Body, ancestor: Body): boolean {
    const ancestorPath = this.#ancestry.get(ancestor);
    const bodyPath = this.#ancestry.get(body);

    return ancestorPath !== undefined &&
      bodyPath?.[ancestorPath.length - 1] === ancestor;
  }

  pathFrom(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined {
    const ancestorPath = this.#ancestry.get(ancestor);
    const descendantPath = this.#ancestry.get(descendant);

    if (
      ancestorPath === undefined ||
      descendantPath?.[ancestorPath.length - 1] !== ancestor
    ) {
      return undefined;
    }
    const path: BodyPathStep[] = [];

    for (let index = ancestorPath.length; index < descendantPath.length; index += 1) {
      const body = descendantPath[index];

      assert(body !== undefined, "missing body on descendant path");
      const owner = this.#owners.get(body);

      assert(owner !== undefined, "descendant body has no owner");
      path.push({ body, owner });
    }

    return path;
  }

  dominatingSite(sites: readonly ScheduleSite[]): ScheduleSite {
    let result: ScheduleSite | undefined;

    for (const site of sites) {
      result = result === undefined ? site : this.#commonDominator(result, site);
    }

    assert(result !== undefined, "demanded value has no demand site");
    return result;
  }

  #recordOwners(body: Body): void {
    const ancestry = this.#ancestry.get(body);

    assert(ancestry !== undefined, "body has no ancestry");
    body.actions.forEach((action, actionIndex) => {
      if (action.kind === "loop") {
        this.#loopBodies.add(action.body);
      }

      for (const nested of nestedBodies(action)) {
        this.#owners.set(nested, { body, actionIndex });
        this.#ancestry.set(nested, [...ancestry, nested]);
        this.#recordOwners(nested);
      }
    });
  }

  #recordBody(
    body: Body,
    ownerSite?: ScheduleSite,
    bodyProduced: readonly ValueId[] = []
  ): void {
    const produced = new Set<ValueId>(bodyProduced);

    body.actions.forEach((action, actionIndex) => {
      const actionSite = { body, actionIndex };
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

      switch (action.kind) {
        case "op": {
          const access = opAccess(action.op);
          const output = actionOutput(action, access);

          if (output === undefined) {
            this.#roots.push(...access.valueInputs.map(demand));
            break;
          }

          assert(!this.#producers.has(output), `value ${output} already has a producer`);
          assert(access.writes.length === 0, `producer ${output} has writes`);
          this.#producers.set(output, {
            output,
            action,
            site: actionSite,
            inputs: access.valueInputs
          });
          produced.add(output);
          break;
        }
        case "if":
          this.#roots.push(demand(action.condition));
          break;
        case "switch": {
          this.#roots.push(demand(action.selector));
          const results: ValueDemand[] = [];

          for (const nested of nestedBodies(action)) {
            const result = nested.result;

            assert(result !== undefined, "switch arm has no result");
            const fallthrough = { body: nested, actionIndex: nested.actions.length };

            results.push({
              value: result,
              requiredAt: valueDependsOn(
                this.#block.values,
                result,
                bodyProducedOutputs(nested)
              )
                ? fallthrough
                : actionSite,
              consumedAt: fallthrough
            });
          }

          assert(
            !this.#controlDependencies.has(action.output),
            `value ${action.output} already has a control producer`
          );
          this.#controlDependencies.set(action.output, results);
          produced.add(action.output);
          break;
        }
        case "loop":
          for (const cell of action.carried) {
            this.#roots.push(demand(cell.seed));
          }
          break;
        case "loopContinue":
          for (const update of action.updates) {
            this.#roots.push(demand(update));
          }
          break;
        case "finish":
          for (const operand of finishOperands(action.finish)) {
            this.#roots.push(demand(operand));
          }
          break;
      }

      for (const nested of nestedBodies(action)) {
        this.#recordBody(nested, actionSite, loopInputsOf(action));
      }
    });
  }

  #recordExports(body: Body, exportedOutputs: Iterable<ValueId>): void {
    const lastActionIndex = body.actions.length - 1;
    const actionIndex = bodyFinal(body) === undefined
      ? body.actions.length
      : lastActionIndex;
    const site = { body, actionIndex };

    for (const output of exportedOutputs) {
      this.#roots.push({ value: output, requiredAt: site, consumedAt: site });
    }
  }

  #commonDominator(a: ScheduleSite, b: ScheduleSite): ScheduleSite {
    const body = this.#commonBody(a.body, b.body);

    return {
      body,
      actionIndex: Math.min(
        this.#projectedIndex(a, body),
        this.#projectedIndex(b, body)
      )
    };
  }

  #commonBody(a: Body, b: Body): Body {
    const aPath = this.#ancestry.get(a);
    const bPath = this.#ancestry.get(b);

    assert(aPath !== undefined && bPath !== undefined, "demand body has no ancestry");
    let common: Body | undefined;

    for (let index = 0; index < Math.min(aPath.length, bPath.length); index += 1) {
      if (aPath[index] !== bPath[index]) {
        break;
      }
      common = aPath[index];
    }

    assert(common !== undefined, "demand sites share no body ancestor");
    return common;
  }

  #projectedIndex(site: ScheduleSite, body: Body): number {
    if (site.body === body) {
      return site.actionIndex;
    }
    const bodyPath = this.#ancestry.get(body);
    const sitePath = this.#ancestry.get(site.body);

    assert(
      bodyPath !== undefined && sitePath?.[bodyPath.length - 1] === body,
      "demand site is outside its dominating body"
    );
    const child = sitePath[bodyPath.length];

    assert(child !== undefined, "demand site has no projected child body");
    const owner = this.#owners.get(child);

    assert(owner !== undefined && owner.body === body, "projected child has the wrong owner");
    return owner.actionIndex;
  }
}
