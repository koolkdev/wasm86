import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockSchedule,
  BlockScheduleEntryIndex,
  DefinitionScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import type { ValueSite } from "./value-sites.js";
import type {
  PlannedLifetime,
  PlannedProducedValue
} from "./types.js";

export type ProducedValue = Readonly<{
  id: BlockDefinitionId;
  entryIndex: BlockScheduleEntryIndex;
  at: Placement;
  entry: DefinitionScheduleEntry;
}>;

export type {
  PlannedProducedValue
} from "./types.js";

export function producedValuesForSchedule(input: {
  schedule: BlockSchedule;
}): readonly ProducedValue[] {
  const produced: ProducedValue[] = [];

  for (const [index, entry] of input.schedule.entries()) {
    if (entry.role !== "definition") {
      continue;
    }

    produced.push(Object.freeze({
      id: entry.definition.id,
      entryIndex: index as BlockScheduleEntryIndex,
      at: entry.at,
      entry
    }));
  }

  return Object.freeze(produced);
}

export function planProducedValues(
  producedValues: readonly ProducedValue[],
  sites: readonly ValueSite[]
): readonly PlannedProducedValue[] {
  const consumersByDefinition = indexSitesByDefinition(sites);

  return Object.freeze(producedValues.map((produced) => {
    const consumers = consumersByDefinition.get(produced.id) ?? Object.freeze([]);

    return Object.freeze({
      produced,
      consumers: Object.freeze(consumers),
      lifetime: producedLifetime(produced, consumers)
    } satisfies PlannedProducedValue);
  }));
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
  let lastEntry = produced.entryIndex;

  for (const consumer of consumers) {
    if (consumer.entryIndex > lastEntry) {
      lastEntry = consumer.entryIndex;
    }
  }

  return Object.freeze({
    firstEntry: produced.entryIndex,
    lastEntry
  });
}
