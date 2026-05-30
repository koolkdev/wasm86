import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import { placementAfter } from "#ir/block/timeline.js";
import type { RootValueAnalysis } from "./root-analysis.js";
import type { ValueRoot } from "./value-roots.js";
import type {
  PlannedLifetime,
  PlannedProducedValue
} from "./types.js";

export type ProducedValue = Readonly<{
  id: BlockDefinitionId;
  at: Placement;
  site: BlockDefinitionSite;
}>;

export type {
  PlannedProducedValue
} from "./types.js";

export function producedValuesForDefinitions(input: {
  definitions: readonly BlockDefinitionSite[];
}): readonly ProducedValue[] {
  const produced: ProducedValue[] = [];

  for (const site of input.definitions) {
    produced.push(Object.freeze({
      id: site.definition.id,
      at: site.at,
      site
    }));
  }

  return Object.freeze(produced);
}

export function planProducedValues(
  producedValues: readonly ProducedValue[],
  analyses: readonly RootValueAnalysis[]
): readonly PlannedProducedValue[] {
  const indexes = indexProducedRoots(analyses);
  const planned: PlannedProducedValue[] = [];

  for (const produced of producedValues) {
    const consumers = indexes.consumersByDefinition.get(produced.id);

    if (consumers === undefined || consumers.length === 0) {
      continue;
    }

    planned.push(Object.freeze({
      produced,
      inputs: indexes.inputsByDefinitionSite.get(produced.site) ?? Object.freeze([]),
      consumers,
      lifetime: producedLifetime(produced, consumers)
    } satisfies PlannedProducedValue));
  }

  return Object.freeze(planned);
}

type ProducedRootIndexes = Readonly<{
  inputsByDefinitionSite: ReadonlyMap<BlockDefinitionSite, readonly ValueRoot[]>;
  consumersByDefinition: ReadonlyMap<BlockDefinitionId, readonly ValueRoot[]>;
}>;

function indexProducedRoots(
  analyses: readonly RootValueAnalysis[]
): ProducedRootIndexes {
  const inputsByDefinitionSite = new Map<BlockDefinitionSite, ValueRoot[]>();
  const consumersByDefinition = new Map<BlockDefinitionId, ValueRoot[]>();

  for (const analysis of analyses) {
    indexDefinitionInputRoot(inputsByDefinitionSite, analysis.valueRoot);

    for (const definitionId of analysis.deps.definitionIds) {
      let indexedRoots = consumersByDefinition.get(definitionId);

      if (indexedRoots === undefined) {
        indexedRoots = [];
        consumersByDefinition.set(definitionId, indexedRoots);
      }

      indexedRoots.push(analysis.valueRoot);
    }
  }

  return Object.freeze({
    inputsByDefinitionSite: freezeRootIndex(inputsByDefinitionSite),
    consumersByDefinition: freezeRootIndex(consumersByDefinition)
  });
}

function indexDefinitionInputRoot(
  inputsByDefinitionSite: Map<BlockDefinitionSite, ValueRoot[]>,
  root: ValueRoot
): void {
  if (root.root.purpose.kind !== "definitionInput") {
    return;
  }

  if (root.root.site.kind !== "definition") {
    throw new Error("definition-input value root must reference a definition site");
  }

  const roots = inputsByDefinitionSite.get(root.root.site);

  if (roots === undefined) {
    inputsByDefinitionSite.set(root.root.site, [root]);
  } else {
    roots.push(root);
  }
}

function freezeRootIndex<Key>(
  mutableIndex: ReadonlyMap<Key, readonly ValueRoot[]>
): ReadonlyMap<Key, readonly ValueRoot[]> {
  const index = new Map<Key, readonly ValueRoot[]>();

  for (const [key, roots] of mutableIndex.entries()) {
    index.set(key, Object.freeze([...roots]));
  }

  return index;
}

function producedLifetime(
  produced: ProducedValue,
  consumers: readonly ValueRoot[]
): PlannedLifetime {
  let end = produced.at;

  for (const consumer of consumers) {
    if (placementAfter(consumer.root.at, end)) {
      end = consumer.root.at;
    }
  }

  return Object.freeze({
    start: produced.at,
    end
  });
}
