import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import { placementAfter } from "#ir/block/timeline.js";
import type { ValueSite } from "./value-sites.js";
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
  sites: readonly ValueSite[]
): readonly PlannedProducedValue[] {
  const consumersByDefinition = indexSitesByDefinition(sites);
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

function indexSitesByDefinition(
  sites: readonly ValueSite[]
): ReadonlyMap<BlockDefinitionId, readonly ValueSite[]> {
  const mutableIndex = new Map<BlockDefinitionId, ValueSite[]>();

  for (const site of sites) {
    for (const definitionId of new Set(site.deps.definitionIds)) {
      let indexedSites = mutableIndex.get(definitionId);

      if (indexedSites === undefined) {
        indexedSites = [];
        mutableIndex.set(definitionId, indexedSites);
      }

      indexedSites.push(site);
    }
  }

  const index = new Map<BlockDefinitionId, readonly ValueSite[]>();

  for (const [definitionId, indexedSites] of mutableIndex.entries()) {
    index.set(definitionId, Object.freeze(indexedSites));
  }

  return index;
}

function producedLifetime(
  produced: ProducedValue,
  consumers: readonly ValueSite[]
): PlannedLifetime {
  let end = produced.at;

  for (const consumer of consumers) {
    if (placementAfter(consumer.at, end)) {
      end = consumer.at;
    }
  }

  return Object.freeze({
    start: produced.at,
    end
  });
}
