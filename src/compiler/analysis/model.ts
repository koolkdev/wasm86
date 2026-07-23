import type { StorageAccess } from "#compiler/ir/effects.js";
import type { Invocation } from "#compiler/ir/invocation.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Region, RegionNode } from "#compiler/ir/region.js";

declare const siteIdBrand: unique symbol;

export type SiteId = number & { readonly [siteIdBrand]: "function-analysis-site" };

export type RegionNodeSite = Readonly<{
  id: SiteId;
  kind: "node";
  region: Region;
  nodeIndex: number;
  node: RegionNode;
}>;

export type RegionEndSite = Readonly<{
  id: SiteId;
  kind: "regionEnd";
  region: Region;
  nodeIndex: number;
}>;

export type RegionSite = RegionNodeSite | RegionEndSite;

export type RegionPathStep = Readonly<{
  region: Region;
  owner: SiteId;
}>;

export type ValueDemand = Readonly<{
  value: ValueId;
  consumedAt: SiteId;
}>;

export type Producer = Readonly<{
  output: ValueId;
  operation: Operation;
  site: SiteId;
  inputs: readonly ValueId[];
}>;

export type JoinControlProducer = Readonly<{
  site: SiteId;
}>;

export type OperationSite = Readonly<{
  operation: Operation;
  site: SiteId;
}>;

export type InvocationSite = Readonly<{
  invocation: Invocation;
  site: SiteId;
}>;

export type FunctionAnalysis = Readonly<{
  sites(): readonly RegionSite[];
  siteOf(region: Region, nodeIndex: number): SiteId;
  path(ancestor: Region, descendant: Region): readonly RegionPathStep[] | undefined;
  isLoopRegion(region: Region): boolean;
  dominatingSite(sites: readonly SiteId[]): SiteId;
  regionEndSite(region: Region): SiteId;

  roots(): readonly ValueDemand[];
  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined;
  controlProducer(output: ValueId): JoinControlProducer | undefined;
  producer(output: ValueId): Producer | undefined;

  isLive(id: ValueId): boolean;
  useCount(id: ValueId): number;
  writesAt(site: SiteId): readonly StorageAccess[];

  operations(): readonly OperationSite[];
  invocations(): readonly InvocationSite[];
  operationMustExecute(operation: Operation): boolean;
  invocationMustExecute(site: InvocationSite): boolean;
}>;
