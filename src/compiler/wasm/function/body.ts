import type { BranchHint } from "#compiler/function/control.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceEffect, StorageWidth } from "#compiler/function/resource.js";
import {
  noStorageEffects,
  type StorageEffects,
  type VariableRef
} from "#compiler/function/storage.js";
import type { VariableWriteInitialization } from "#compiler/function/operation.js";
import type { WasmValueGraph } from "./values/graph.js";
import type { WasmValueId } from "./values/nodes.js";

declare const siteIdBrand: unique symbol;

// One executable operation, control, or region end in the lowered body.
export type SiteId = number & { readonly [siteIdBrand]: "wasm-site" };

export function siteId(index: number): SiteId {
  return index as SiteId;
}

declare const blockIdBrand: unique symbol;

// One lowered region in the target body.
export type BlockId = number & { readonly [blockIdBrand]: "wasm-block" };

export function blockId(index: number): BlockId {
  return index as BlockId;
}

export type BodyEvent =
  | Readonly<{
      kind: "load";
      storageWidth: StorageWidth;
      effect: ResourceEffect;
      displacement: number;
      address: WasmValueId;
      output: WasmValueId;
    }>
  | Readonly<{
      kind: "store";
      storageWidth: StorageWidth;
      effect: ResourceEffect;
      displacement: number;
      address: WasmValueId;
      value: WasmValueId;
    }>
  | Readonly<{ kind: "variableRead"; variable: VariableRef; output: WasmValueId }>
  | Readonly<{
      kind: "variableWrite";
      variable: VariableRef;
      value: WasmValueId;
      initialization: VariableWriteInitialization;
    }>
  | Readonly<{
      kind: "call";
      target: CallTarget;
      operands: readonly WasmValueId[];
      output: WasmValueId | undefined;
    }>
  | Readonly<{
      kind: "if";
      hint: BranchHint | undefined;
      condition: WasmValueId;
      arms: readonly BlockId[];
      output: WasmValueId | undefined;
    }>
  | Readonly<{
      kind: "switch";
      caseMatches: readonly (readonly number[])[];
      selector: WasmValueId;
      arms: readonly BlockId[];
      output: WasmValueId | undefined;
    }>
  | Readonly<{
      kind: "loop";
      body: BlockId;
      seeds: readonly WasmValueId[];
      inputs: readonly WasmValueId[];
    }>
  | Readonly<{ kind: "loopContinue"; updates: readonly WasmValueId[] }>
  | Readonly<{ kind: "return"; operands: readonly WasmValueId[] }>
  | Readonly<{ kind: "returnCall"; target: CallTarget; operands: readonly WasmValueId[] }>
  | Readonly<{
      kind: "end";
      result: WasmValueId | undefined;
      fallsThrough: boolean;
    }>;

// The generic dependency view shared by planning passes. Structured children
// and region results remain on the concrete event variants.
type BodyEventDescription = Readonly<{
  category: "operation" | "control" | "end";
  operands: readonly WasmValueId[];
  output: WasmValueId | undefined;
  effects: StorageEffects;
}>;

function describe(event: BodyEvent): BodyEventDescription {
  switch (event.kind) {
    case "load":
      return {
        category: "operation",
        operands: [event.address],
        output: event.output,
        effects: { reads: [event.effect], writes: [] }
      };
    case "store":
      return {
        category: "operation",
        operands: [event.address, event.value],
        output: undefined,
        effects: { reads: [], writes: [event.effect] }
      };
    case "variableRead":
      return {
        category: "operation",
        operands: [],
        output: event.output,
        effects: { reads: [event.variable], writes: [] }
      };
    case "variableWrite":
      return {
        category: "operation",
        operands: [event.value],
        output: undefined,
        effects: { reads: [], writes: [event.variable] }
      };
    case "call":
      return {
        category: "operation",
        operands: event.operands,
        output: event.output,
        effects: event.target.effects
      };
    case "if":
      return {
        category: "control",
        operands: [event.condition],
        output: event.output,
        effects: noStorageEffects
      };
    case "switch":
      return {
        category: "control",
        operands: [event.selector],
        output: event.output,
        effects: noStorageEffects
      };
    case "loop":
      return {
        category: "control",
        operands: event.seeds,
        output: undefined,
        effects: noStorageEffects
      };
    case "loopContinue":
      return {
        category: "control",
        operands: event.updates,
        output: undefined,
        effects: noStorageEffects
      };
    case "return":
      return {
        category: "control",
        operands: event.operands,
        output: undefined,
        effects: noStorageEffects
      };
    case "returnCall":
      return {
        category: "control",
        operands: event.operands,
        output: undefined,
        effects: event.target.effects
      };
    case "end":
      return {
        category: "end",
        // A region result is demanded only when its owning join is live.
        operands: [],
        output: undefined,
        effects: noStorageEffects
      };
  }
}

export const BodyEvent = { describe } as const;

// A control site precedes its child blocks; each block's end site follows them.
export type BodySite = Readonly<{
  block: BlockId;
  event: BodyEvent;
}>;

export type WasmBody = Readonly<{
  parameterCount: number;
  values: WasmValueGraph;
  entryBlock: BlockId;
  sites: readonly BodySite[];
}>;
