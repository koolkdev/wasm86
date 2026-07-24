import type { StorageEffects } from "#compiler/ir/effects.js";
import type { NestedRegion } from "#compiler/ir/node.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";

export type BranchHint = "unlikely" | "likely";

export type ControlNodeBase = Readonly<{
  category: "control";
  kind: string;
}>;

export type DerivedControlDescription = Readonly<{
  operands: readonly ValueId[];
  outputs: readonly [] | readonly [ValueId];
  nestedBodies: readonly NestedRegion[];
  effects: StorageEffects;
}>;

export type ControlCompletionContext = Readonly<{
  regionCompletes: (body: Region) => boolean;
}>;

export type ControlDefinition<
  CreateArgs,
  Entry extends ControlNodeBase
> = Readonly<{
  kind: Entry["kind"];
  create(args: CreateArgs): Entry;
  describe(control: Entry): DerivedControlDescription;
  mapBodies(control: Entry, map: (body: Region) => Region): Entry;
  completes(control: Entry, context: ControlCompletionContext): boolean;
}>;
