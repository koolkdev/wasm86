import type { BlockExit } from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockDefinitionSite
} from "#ir/block/timeline.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  BlockLayout,
  LayoutTimelineInput
} from "#ir/block/planning/layout/index.js";
import type {
  PlannedStateWrite,
  StateWritePlan
} from "#ir/block/planning/state-writes.js";
import type { WasmValueCache } from "../cache/locals/index.js";
import type { WasmEmittedValue } from "../values/types.js";
import type { WasmRecipeEmitter } from "../values/recipes.js";

export type WasmLayoutInputEmitter = (input: LayoutTimelineInput) => WasmEmittedValue;

export type WasmLayoutActionEdge = Readonly<{
  edge: BlockEdgeId;
  exit: BlockExit;
}>;

export type WasmDefinitionEmitter = Readonly<{
  emitDefinition(input: WasmDefinitionEmitInput): void;
}>;

export type WasmDefinitionEmitInput = Readonly<{
  site: BlockDefinitionSite;
  inputs: readonly LayoutTimelineInput[];
  emitInput: WasmLayoutInputEmitter;
}>;

export type WasmActionEmitter = Readonly<{
  emitActionInputs(input: WasmActionInputsEmitInput): void;
  emitActionEffect(input: WasmActionEffectEmitInput): void;
}>;

export type WasmActionInputsEmitInput = Readonly<{
  site: BlockActionSite;
  inputs: readonly LayoutTimelineInput[];
  emitInput: WasmLayoutInputEmitter;
}>;

export type WasmActionEffectEmitInput = Readonly<{
  site: BlockActionSite;
  inputs: readonly LayoutTimelineInput[];
  edges: readonly WasmLayoutActionEdge[];
  emitInput: WasmLayoutInputEmitter;
  emitEdge(edge: BlockEdgeId): void;
}>;

export type WasmStateWriteEmitter = Readonly<{
  emitStateWrite(input: WasmStateWriteEmitInput): void;
}>;

export type WasmStateWriteEmitInput = Readonly<{
  write: PlannedStateWrite;
  satisfies: readonly PlannedStateWrite[];
  emitValue?: () => WasmEmittedValue;
}>;

export type WasmExitEmitter = Readonly<{
  emitExit(input: WasmExitEmitInput): void;
}>;

export type WasmExitEmitInput = Readonly<{
  exit: BlockExit;
}>;

export type WasmLayoutDriverInput = Readonly<{
  layout: BlockLayout;
  stateWrites: StateWritePlan;
  cache: WasmValueCache;
  recipes: WasmRecipeEmitter;
  definitions: WasmDefinitionEmitter;
  actions: WasmActionEmitter;
  stateWriteEmitter: WasmStateWriteEmitter;
  exits: WasmExitEmitter;
}>;

export type WasmLayoutDriver = Readonly<{
  emit(): void;
}>;
