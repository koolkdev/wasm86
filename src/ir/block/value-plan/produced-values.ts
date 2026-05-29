import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  BlockSchedule,
  DefinitionScheduleEntry,
  Placement
} from "#ir/block/schedule.js";

export type ProducedValue = Readonly<{
  id: BlockDefinitionId;
  order: number;
  at: Placement;
  entry: DefinitionScheduleEntry;
}>;

export function producedValuesForSchedule(input: {
  schedule: BlockSchedule;
}): readonly ProducedValue[] {
  const produced: ProducedValue[] = [];

  for (const [order, entry] of input.schedule.entries()) {
    if (entry.role !== "definition") {
      continue;
    }

    produced.push(Object.freeze({
      id: entry.definition.id,
      order,
      at: entry.at,
      entry
    }));
  }

  return Object.freeze(produced);
}
