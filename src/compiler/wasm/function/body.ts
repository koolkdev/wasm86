import type { BranchHint } from "#compiler/function/control.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceEffect, StorageWidth } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
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
