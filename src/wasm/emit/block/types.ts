import type { BlockExit } from "#ir/block/exits.js";
import type { BlockActionSite } from "#ir/block/timeline.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  BlockLayout,
  LayoutTimelineInput
} from "#ir/block/planning/layout/index.js";
import type {
  PlannedStateWrite,
  StateWritePlan
} from "#ir/block/planning/state-writes.js";
import type {
  WasmValueCache,
  WasmValueCacheLocalEmission
} from "../cache/locals/index.js";
import type { WasmEmittedValue } from "../values/types.js";
import type { WasmRecipeEmitter } from "../values/recipes.js";

export type WasmLayoutInputEmitter = (input: LayoutTimelineInput) => WasmEmittedValue;

export type WasmLayoutActionEdge = Readonly<{
  edge: BlockEdgeId;
  exit: BlockExit;
  exitPayload: WasmLayoutExitPayload;
}>;

export type WasmLayoutExitPayload =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "input"; input: LayoutTimelineInput }>;

export type WasmActionEmitter = Readonly<{
  emitActionInputs(input: WasmActionInputsEmitInput): void;
  emitActionEffect(input: WasmActionEffectEmitInput): void;
}>;

export type WasmActionInputRole = Extract<LayoutTimelineInput["use"], { kind: "action-input" }>["role"];

export type WasmActionOperands = Readonly<{
  has(role: WasmActionInputRole): boolean;
  emitStack(role: WasmActionInputRole): WasmEmittedValue;
  emitLocal(role: WasmActionInputRole): WasmValueCacheLocalEmission;
  local(role: WasmActionInputRole): WasmValueCacheLocalEmission;
  release(): void;
}>;

export type WasmActionInputsEmitInput = Readonly<{
  site: BlockActionSite;
  inputs: readonly LayoutTimelineInput[];
  operands: WasmActionOperands;
}>;

export type WasmActionEffectEmitInput = Readonly<{
  site: BlockActionSite;
  operands: WasmActionOperands;
  edges: readonly WasmLayoutActionEdge[];
  emitEdge(edge: WasmLayoutActionEdge): void;
}>;

export type WasmStateWriteEmitter = Readonly<{
  emitStateWrite(input: WasmStateWriteEmitInput): void;
}>;

export type WasmStateWriteEmitInput = Readonly<{
  write: PlannedStateWrite;
  satisfies: readonly PlannedStateWrite[];
  emitValue: () => WasmEmittedValue;
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
  actions: WasmActionEmitter;
  stateWriteEmitter: WasmStateWriteEmitter;
  exits: WasmExitEmitter;
}>;

export type WasmLayoutDriver = Readonly<{
  emit(): void;
}>;
