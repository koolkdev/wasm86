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
  const consumersByDefinition = indexRootsByDefinition(analyses);
  const planned: PlannedProducedValue[] = [];

  for (const produced of producedValues) {
    const consumers = consumersByDefinition.get(produced.id);

    if (consumers === undefined || consumers.length === 0) {
      continue;
    }

    planned.push(Object.freeze({
      produced,
      consumers,
      lifetime: producedLifetime(produced, consumers)
    } satisfies PlannedProducedValue));
  }

  return Object.freeze(planned);
}

function indexRootsByDefinition(
  analyses: readonly RootValueAnalysis[]
): ReadonlyMap<BlockDefinitionId, readonly ValueRoot[]> {
  const mutableIndex = new Map<BlockDefinitionId, ValueRoot[]>();

  for (const analysis of analyses) {
    for (const definitionId of new Set(analysis.deps.definitionIds)) {
      let indexedRoots = mutableIndex.get(definitionId);

      if (indexedRoots === undefined) {
        indexedRoots = [];
        mutableIndex.set(definitionId, indexedRoots);
      }

      indexedRoots.push(analysis.valueRoot);
    }
  }

  const index = new Map<BlockDefinitionId, readonly ValueRoot[]>();

  for (const [definitionId, indexedRoots] of mutableIndex.entries()) {
    index.set(definitionId, Object.freeze(indexedRoots));
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
