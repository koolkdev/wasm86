import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import {
  BodyEvent,
  type BlockId,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import {
  wasmValueId,
  wasmValueSource,
  type WasmValueId
} from "#compiler/wasm/function/values/nodes.js";
import {
  PlacementAnalysis,
  type OperationDefinition,
  type ValueDemand
} from "./placement-analysis.js";

type EvaluationDraft = Readonly<{
  value: WasmValueId;
  anchor: SiteId;
  uses: readonly SiteId[];
  isDefault: boolean;
  operationSite: SiteId | undefined;
}>;

export type EvaluationPlacement = EvaluationDraft &
  Readonly<{
    kind: "atUse" | "capture" | "join";
  }>;

export type WasmPlacement = Readonly<{
  evaluations: readonly EvaluationPlacement[];
  // Operations retained for their writes execute at their authored site.
  operationsAtAuthoredSite: Uint8Array;
}>;

export function placeEvaluations(body: WasmBody): WasmPlacement {
  return new EvaluationPlacer(body).place();
}

class EvaluationPlacer {
  readonly #analysis: PlacementAnalysis;
  readonly #demands: (SiteId[] | undefined)[];
  readonly #drafts: (EvaluationDraft[] | undefined)[];
  // Inputs of write-retained operations whose result proved dead during the sweep.
  readonly #discoveredRoots: ValueDemand[] = [];
  readonly #placedValues: WasmValueId[] = [];
  readonly #operationsAtAuthoredSite: Uint8Array;

  constructor(private readonly body: WasmBody) {
    this.#analysis = new PlacementAnalysis(body);
    this.#demands = new Array(body.values.length);
    this.#drafts = new Array(body.values.length);
    this.#operationsAtAuthoredSite = new Uint8Array(body.sites.length);
    for (const site of this.#analysis.authoredOperationSites()) {
      this.#operationsAtAuthoredSite[site] = 1;
    }
  }

  place(): WasmPlacement {
    for (const root of this.#analysis.rootDemands()) {
      this.#addDemand(root.value, root.consumedAt);
    }

    // Inputs have smaller IDs than their users. Walking backward lets every
    // live user add its demands before an input is visited.
    for (let raw = this.body.values.length - 1; raw >= 0; raw -= 1) {
      const value = wasmValueId(raw);
      const demands = this.#demands[value] ?? [];
      const definition = this.#analysis.definition(value);

      if (demands.length === 0) {
        if (definition?.kind === "operation" && definition.hasWrites) {
          // A dead result does not remove an operation retained for its writes.
          // Pin it here and turn its operands into roots for the remaining sweep.
          this.#operationsAtAuthoredSite[definition.site] = 1;
          for (const input of definition.operands) {
            const root = { value: input, consumedAt: definition.site };

            this.#discoveredRoots.push(root);
            this.#addDemand(input, definition.site);
          }
        }
        continue;
      }

      if (definition?.kind === "operation") {
        const anchor = this.#operationAnchor(definition, demands);

        this.#placeValue(value, anchor, demands, true, definition.site);
        for (const input of definition.operands) {
          this.#addDemand(input, anchor);
        }
        continue;
      }

      if (definition?.kind === "join") {
        this.#placeValue(value, definition.site, demands, true, undefined);
        for (const input of definition.dependencies) {
          this.#addDemand(input.value, input.consumedAt);
        }
        continue;
      }

      const node = this.body.values.node(value);

      if (wasmValueSource(node) === "expression") {
        this.#placeExpressionUses(value, demands, true);
      } else {
        assert(node.kind !== "producerOutput", `output value ${value} has no definition`);
      }
    }

    const evaluations: EvaluationPlacement[] = [];

    // The sweep logs values from users toward inputs. Reverse replay restores
    // first-demand order and keeps one value's split evaluations adjacent.
    for (let index = this.#placedValues.length - 1; index >= 0; index -= 1) {
      const value = this.#placedValues[index];

      assert(value !== undefined, "placement order has no value");
      for (const draft of this.#drafts[value] ?? []) {
        evaluations.push({
          ...draft,
          kind:
            this.#analysis.definition(value)?.kind === "join"
              ? "join"
              : draft.uses.includes(draft.anchor)
                ? "atUse"
                : "capture"
        });
      }
    }

    return {
      evaluations,
      operationsAtAuthoredSite: this.#operationsAtAuthoredSite
    };
  }

  #placeValue(
    value: WasmValueId,
    anchor: SiteId,
    uses: readonly SiteId[],
    isDefault: boolean,
    operationSite: SiteId | undefined
  ): void {
    let drafts = this.#drafts[value];

    if (drafts === undefined) {
      drafts = [];
      this.#drafts[value] = drafts;
      this.#placedValues.push(value);
    }
    if (buildDefinition.validation) {
      const previous = this.#placedValues[this.#placedValues.length - 2];

      assert(
        previous === undefined || previous > value,
        `value ${value} is logged after ${previous}`
      );
      assert(
        !isDefault || drafts.every((candidate) => !candidate.isDefault),
        `value ${value} has two default evaluations`
      );
      assert(
        drafts.every((candidate) => !uses.some((use) => candidate.uses.includes(use))),
        `value ${value} has two evaluations at one use`
      );
    }
    drafts.push({ value, anchor, uses, isDefault, operationSite });
  }

  #placeExpression(value: WasmValueId, uses: readonly SiteId[], isDefault: boolean): void {
    let anchor = this.#analysis.index.dominatingSite(uses);

    anchor = this.#liftLoopInvariant(value, anchor);
    this.#placeValue(value, anchor, uses, isDefault, undefined);
    for (const input of this.body.values.node(value).inputs) {
      this.#addDemand(input, anchor);
    }
  }

  #placeExpressionUses(value: WasmValueId, uses: readonly SiteId[], isDefault: boolean): void {
    // Unsafe evaluations stay within selected arms unless mandatory predecessors
    // make a shared capture safe. A terminal hinted arm may also keep its own copy.
    const selectedGroups = this.#analysis.canSpeculateEvaluation(value)
      ? undefined
      : this.#groupSelectedUses(uses);
    const groups = selectedGroups ?? this.#groupHintedUses(uses);
    const canShareSelected =
      selectedGroups !== undefined &&
      this.#canCaptureAfterMandatoryPredecessors(value, this.#analysis.index.dominatingSite(uses));

    if (
      groups === undefined ||
      (shouldShareEvaluation(this.body, value) &&
        (selectedGroups === undefined || canShareSelected))
    ) {
      this.#placeExpression(value, uses, isDefault);
      return;
    }

    for (const [index, group] of groups.entries()) {
      this.#placeExpressionUses(value, group, isDefault && index === 0);
    }
  }

  #operationAnchor(definition: OperationDefinition, demands: readonly SiteId[]): SiteId {
    let anchor = this.#analysis.index.dominatingSite(demands);

    anchor = this.#clampBeforeNestedLoop(this.#analysis.index.site(definition.site).block, anchor);
    if (
      !this.#isAfterProducer(definition.site, anchor) ||
      definition.hasWrites ||
      definition.operands.some((input) => !this.#analysis.canSpeculateEvaluation(input)) ||
      this.#analysis.crossesAliasingWrite(definition.reads, definition.site, anchor)
    ) {
      return definition.site;
    }
    return anchor;
  }

  #clampBeforeNestedLoop(producerBlock: BlockId, anchor: SiteId): SiteId {
    const path = this.#analysis.index.path(producerBlock, this.#analysis.index.site(anchor).block);

    assert(path !== undefined, "operation demand leaves its definition scope");
    for (const step of path) {
      if (this.#analysis.index.loopOwner(step.block) !== undefined) {
        return step.ownerSite;
      }
    }
    return anchor;
  }

  #isAfterProducer(producer: SiteId, anchor: SiteId): boolean {
    const producerSite = this.#analysis.index.site(producer);
    const anchorSite = this.#analysis.index.site(anchor);

    if (producerSite.block === anchorSite.block) {
      return anchor > producer;
    }
    const first = this.#analysis.index.path(producerSite.block, anchorSite.block)?.[0];

    return first !== undefined && first.ownerSite > producer;
  }

  #liftLoopInvariant(value: WasmValueId, anchor: SiteId): SiteId {
    let result = anchor;

    // Leave loop bodies until reaching the innermost loop required by an input.
    // A loop's owner site is its preheader in the surrounding block.
    while (this.#analysis.canSpeculateEvaluation(value)) {
      const block = this.#analysis.index.site(result).block;
      const owner = this.#analysis.index.loopOwner(block);

      if (owner === undefined || this.#analysis.requiredLoop(value) === block) {
        return result;
      }
      result = owner;
    }
    return result;
  }

  #groupSelectedUses(uses: readonly SiteId[]): readonly (readonly SiteId[])[] | undefined {
    const anchor = this.#analysis.index.dominatingSite(uses);
    const site = this.#analysis.index.site(anchor);
    const event = site.event;

    if (uses.includes(anchor) || (event.kind !== "if" && event.kind !== "switch")) {
      return undefined;
    }
    const groups = new Map<BlockId | undefined, SiteId[]>();

    for (const use of uses) {
      const first = this.#analysis.index.path(
        site.block,
        this.#analysis.index.site(use).block
      )?.[0];
      const selectedBlock = first?.ownerSite === anchor ? first.block : undefined;
      const group = groups.get(selectedBlock);

      if (group === undefined) {
        groups.set(selectedBlock, [use]);
      } else {
        group.push(use);
      }
    }
    return groups.size > 1 ? [...groups.values()] : undefined;
  }

  #groupHintedUses(
    uses: readonly SiteId[]
  ): readonly [readonly SiteId[], readonly SiteId[]] | undefined {
    const anchor = this.#analysis.index.dominatingSite(uses);
    const site = this.#analysis.index.site(anchor);
    const event = site.event;

    if (uses.includes(anchor) || event.kind !== "if") {
      return undefined;
    }
    const otherArm = event.hint === "unlikely" ? 0 : event.hint === "likely" ? 1 : undefined;
    const otherBlock = otherArm === undefined ? undefined : event.arms[otherArm];

    if (otherBlock === undefined) {
      return undefined;
    }
    const end = this.#analysis.index.site(this.#analysis.index.endSite(otherBlock)).event;

    assert(end.kind === "end", `if arm ${otherBlock} has no end event`);
    if (end.fallsThrough) {
      return undefined;
    }
    const main: SiteId[] = [];
    const other: SiteId[] = [];

    for (const use of uses) {
      const first = this.#analysis.index.path(
        site.block,
        this.#analysis.index.site(use).block
      )?.[0];

      if (first?.ownerSite === anchor && first.block === otherBlock) {
        other.push(use);
      } else {
        main.push(use);
      }
    }
    return main.length === 0 || other.length === 0 ? undefined : [main, other];
  }

  #canCaptureAfterMandatoryPredecessors(value: WasmValueId, site: SiteId): boolean {
    // Roots consumed at a distinct dominating site, plus this control's own
    // operands, are guaranteed to be available before a capture at the header.
    const available = new Set<WasmValueId>();
    const event = this.#analysis.index.site(site).event;
    const addExpression = (root: WasmValueId): void => {
      const pending = [root];

      while (pending.length !== 0) {
        const current = pending.pop();

        if (current === undefined || available.has(current)) {
          continue;
        }
        available.add(current);
        for (const input of this.body.values.node(current).inputs) {
          pending.push(input);
        }
      }
    };
    const addRoot = (root: ValueDemand): void => {
      if (
        root.consumedAt !== site &&
        this.#analysis.index.dominatingSite([root.consumedAt, site]) === root.consumedAt
      ) {
        addExpression(root.value);
      }
    };

    for (const root of this.#analysis.rootDemands()) {
      addRoot(root);
    }
    for (const root of this.#discoveredRoots) {
      addRoot(root);
    }
    if (event.kind === "if" || event.kind === "switch" || event.kind === "loop") {
      for (const operand of BodyEvent.describe(event).operands) {
        addExpression(operand);
      }
    }
    return this.#analysis.canEvaluateWithAvailableValues(value, (candidate) =>
      available.has(candidate)
    );
  }

  #addDemand(value: WasmValueId, consumedAt: SiteId): void {
    this.body.values.node(value);
    this.#analysis.index.site(consumedAt);
    const demands = this.#demands[value];

    if (demands === undefined) {
      this.#demands[value] = [consumedAt];
    } else {
      demands.push(consumedAt);
    }
  }
}

function shouldShareEvaluation(body: WasmBody, value: WasmValueId): boolean {
  const node = body.values.node(value);

  // Keep i32 constant masks path-local so a cold selected use adds no work to
  // the main path.
  return (
    node.kind !== "binary" ||
    node.type !== "i32" ||
    node.operator !== "and" ||
    (body.values.node(node.inputs[0]).kind !== "const" &&
      body.values.node(node.inputs[1]).kind !== "const")
  );
}
