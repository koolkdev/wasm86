import { assert } from "#common/assert.js";
import type { BranchHint } from "#compiler/function/control.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { StorageWidth } from "#compiler/function/resource.js";
import type { StorageAccess } from "#compiler/function/storage.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { WasmValueFacts } from "#compiler/wasm/function/values/facts.js";
import type { WasmValueGraph } from "#compiler/wasm/function/values/graph.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

declare const siteIdBrand: unique symbol;

// A program point of the lowered body: one per region node, one per block end.
export type SiteId = number & { readonly [siteIdBrand]: "wasm-site" };

export function siteId(index: number): SiteId {
  return index as SiteId;
}

declare const blockIdBrand: unique symbol;

// A straight-line run of sites. Block 0 is the function entry.
export type BlockId = number & { readonly [blockIdBrand]: "wasm-block" };

export function blockId(index: number): BlockId {
  return index as BlockId;
}

declare const siteIndexedBrand: unique symbol;

// Positional protocols as types. A site-indexed array is read with a SiteId and
// built only by these factories, so length agreement is structural.
export type SiteIndexed<T> = readonly T[] & { readonly [siteIndexedBrand]: true };
type MutableSiteIndexed<T> = T[] & { readonly [siteIndexedBrand]: true };

export function siteIndexed<T>(siteCount: number, fill: T): MutableSiteIndexed<T> {
  return new Array<T>(siteCount).fill(fill) as MutableSiteIndexed<T>;
}

// Adopts an array grown one entry per site.
export function siteIndexedOf<T>(siteCount: number, entries: readonly T[]): SiteIndexed<T> {
  assert(entries.length === siteCount, "site-indexed array does not cover every site");
  return entries as SiteIndexed<T>;
}

declare const valueIndexedBrand: unique symbol;

export type ValueIndexed<T> = readonly T[] & { readonly [valueIndexedBrand]: true };
type MutableValueIndexed<T> = T[] & { readonly [valueIndexedBrand]: true };

export function valueIndexed<T>(valueCount: number, fill: T): MutableValueIndexed<T> {
  return new Array<T>(valueCount).fill(fill) as MutableValueIndexed<T>;
}

// Sizes an array filled sparsely by value id to the finished value graph.
export function valueIndexedOf<T>(
  valueCount: number,
  entries: (T | undefined)[]
): ValueIndexed<T | undefined> {
  assert(entries.length <= valueCount, "value-indexed array exceeds the value graph");
  entries.length = valueCount;
  const sized: readonly (T | undefined)[] = entries;

  return sized as ValueIndexed<T | undefined>;
}

// One record per block, keyed by dense id. `sites` holds the block's node
// sites in order followed by its close site, so a node index addresses both.
export type BlockInfo = Readonly<{
  parent: BlockId | undefined;
  ownerSite: SiteId | undefined;
  depth: number;
  loopDepth: number;
  isLoop: boolean;
  armIndex: number;
  sites: readonly SiteId[];
  closeSite: SiteId;
  // The block's region falls through its own end only when this is false.
  completes: boolean;
}>;

// The structural bytes a block owes when it closes. Loop bodies and the last
// arm of a join close their control; earlier arms only separate it.
export type CloseEmit = "none" | "else" | "endArm" | "end";

// One event per site, in emission order. Control events carry the skeleton and
// their operands; close events carry the arm result and its structural bytes.
export type BodyEvent =
  | Readonly<{
      kind: "load";
      width: StorageWidth;
      effect: ResourceEffect;
      displacement: number;
      address: WasmValueId;
      output: WasmValueId;
    }>
  | Readonly<{
      kind: "store";
      width: StorageWidth;
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
      seed: boolean;
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
      arms: readonly BlockId[];
      condition: WasmValueId;
      output: WasmValueId | undefined;
    }>
  | Readonly<{
      kind: "switch";
      caseMatches: readonly (readonly number[])[];
      selector: WasmValueId;
      output: WasmValueId | undefined;
    }>
  | Readonly<{ kind: "loop"; seeds: readonly WasmValueId[]; loopInputs: readonly WasmValueId[] }>
  | Readonly<{ kind: "loopContinue"; updates: readonly WasmValueId[] }>
  | Readonly<{ kind: "return"; operands: readonly WasmValueId[] }>
  | Readonly<{ kind: "returnCall"; target: CallTarget; operands: readonly WasmValueId[] }>
  | Readonly<{
      kind: "close";
      block: BlockId;
      result: WasmValueId | undefined;
      emit: CloseEmit;
      seal: boolean;
    }>;

export type SiteRecord = Readonly<{
  block: BlockId;
  nodeIndex: number;
}>;

export type WriteSite = Readonly<{ site: SiteId; writes: readonly StorageAccess[] }>;

export type ValueDemand = Readonly<{ value: WasmValueId; consumedAt: SiteId }>;

// The lowered body. Positional arrays carry the index they answer to in their
// type: site id for the body tables, Wasm value id for the producer tables.
export type WasmBody = Readonly<{
  parameterCount: number;
  values: WasmValueGraph;
  facts: WasmValueFacts;
  sites: SiteIndexed<SiteRecord>;
  events: SiteIndexed<BodyEvent>;
  blocks: readonly BlockInfo[];
  siteReads: SiteIndexed<readonly StorageAccess[]>;
  siteHasWrites: Uint8Array;
  writeSites: readonly WriteSite[];
  producers: ValueIndexed<SiteId | undefined>;
  joinProducers: ValueIndexed<SiteId | undefined>;
  joinDependencies: ValueIndexed<readonly ValueDemand[] | undefined>;
  operationSites: readonly SiteId[];
}>;

export function bodyEvent(body: WasmBody, site: SiteId): BodyEvent {
  const event = body.events[site];

  assert(event !== undefined, `unknown Wasm body site ${site}`);
  return event;
}

// The values a loop block carries, read from the loop event that owns it.
export function loopBlockInputs(body: WasmBody, block: BlockInfo): readonly WasmValueId[] {
  const site = block.ownerSite;

  assert(site !== undefined, "loop block has no owner");
  const event = bodyEvent(body, site);

  assert(event.kind === "loop", "loop block has no loop event");
  return event.loopInputs;
}

const noValues: readonly WasmValueId[] = [];

// The site's operand values in lowering order. Demand seeding and placement
// both read this one list.
export function eventOperands(event: BodyEvent): readonly WasmValueId[] {
  switch (event.kind) {
    case "load":
      return [event.address];
    case "store":
      return [event.address, event.value];
    case "variableRead":
      return noValues;
    case "variableWrite":
      return [event.value];
    case "call":
      return event.operands;
    case "if":
      return [event.condition];
    case "switch":
      return [event.selector];
    case "loop":
      return event.seeds;
    case "loopContinue":
      return event.updates;
    case "return":
    case "returnCall":
      return event.operands;
    case "close":
      return noValues;
  }
}

export function eventOutput(event: BodyEvent): WasmValueId | undefined {
  switch (event.kind) {
    case "load":
    case "variableRead":
    case "call":
    case "if":
    case "switch":
      return event.output;
    case "store":
    case "variableWrite":
    case "loop":
    case "loopContinue":
    case "return":
    case "returnCall":
    case "close":
      return undefined;
  }
}

// Operation events execute at their authored site unless placement moves them.
export function isOperationEvent(event: BodyEvent): boolean {
  switch (event.kind) {
    case "load":
    case "store":
    case "variableRead":
    case "variableWrite":
    case "call":
      return true;
    case "if":
    case "switch":
    case "loop":
    case "loopContinue":
    case "return":
    case "returnCall":
    case "close":
      return false;
  }
}
