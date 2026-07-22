import type { StorageAccess } from "#compiler/ir/effects.js";
import type { Invocation } from "#compiler/ir/invocation.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Body, BodyNode } from "#ir/block.js";

declare const siteIdBrand: unique symbol;

export type SiteId = number & { readonly [siteIdBrand]: "body-analysis-site" };

export type BodyNodeSite = Readonly<{
  id: SiteId;
  kind: "node";
  body: Body;
  nodeIndex: number;
  node: BodyNode;
}>;

export type BodyEndSite = Readonly<{
  id: SiteId;
  kind: "bodyEnd";
  body: Body;
  nodeIndex: number;
}>;

export type BodySite = BodyNodeSite | BodyEndSite;

export type BodyPathStep = Readonly<{
  body: Body;
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

export type BodyAnalysis = Readonly<{
  sites(): readonly BodySite[];
  siteOf(body: Body, nodeIndex: number): SiteId;
  path(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined;
  isLoopBody(body: Body): boolean;
  dominatingSite(sites: readonly SiteId[]): SiteId;
  bodyEndSite(body: Body): SiteId;

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
