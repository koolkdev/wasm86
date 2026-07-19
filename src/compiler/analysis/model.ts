import type { StorageAccess } from "#compiler/ir/effects.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  Action,
  CallAction,
  FunctionCallAction,
  IfAction,
  OpAction,
  SwitchAction
} from "#ir/actions.js";
import type { Body } from "#ir/block.js";

declare const siteIdBrand: unique symbol;

export type SiteId = number & { readonly [siteIdBrand]: "body-analysis-site" };

export type ActionSite = Readonly<{
  id: SiteId;
  kind: "action";
  body: Body;
  actionIndex: number;
  action: Action;
}>;

export type BodyEndSite = Readonly<{
  id: SiteId;
  kind: "bodyEnd";
  body: Body;
  actionIndex: number;
}>;

export type BodySite = ActionSite | BodyEndSite;

export type BodyPathStep = Readonly<{
  body: Body;
  owner: SiteId;
}>;

export type ValueDemand = Readonly<{
  value: ValueId;
  consumedAt: SiteId;
}>;

export type ProducingAction = OpAction | CallAction;

export type Producer = Readonly<{
  output: ValueId;
  action: ProducingAction;
  site: SiteId;
  inputs: readonly ValueId[];
}>;

export type ControlProducer = Readonly<{
  action: IfAction | SwitchAction;
  site: SiteId;
}>;

export type OperationSite = Readonly<{
  action: OpAction;
  site: SiteId;
}>;

export type CallSite = Readonly<{
  action: FunctionCallAction;
  site: SiteId;
}>;

export type BodyAnalysis = Readonly<{
  sites(): readonly BodySite[];
  siteOf(body: Body, actionIndex: number): SiteId;
  path(ancestor: Body, descendant: Body): readonly BodyPathStep[] | undefined;
  isLoopBody(body: Body): boolean;
  dominatingSite(sites: readonly SiteId[]): SiteId;
  bodyEndSite(body: Body): SiteId;

  roots(): readonly ValueDemand[];
  controlDependencies(output: ValueId): readonly ValueDemand[] | undefined;
  controlProducer(output: ValueId): ControlProducer | undefined;
  producer(output: ValueId): Producer | undefined;

  isLive(id: ValueId): boolean;
  useCount(id: ValueId): number;
  writesAt(site: SiteId): readonly StorageAccess[];
  exportedOutputs(): readonly ValueId[];

  operations(): readonly OperationSite[];
  calls(): readonly CallSite[];
  actionEffects(action: ProducingAction): Readonly<{
    reads: readonly StorageAccess[];
    writes: readonly StorageAccess[];
  }>;
  actionMustExecute(action: ProducingAction): boolean;
  opActionMustExecute(action: OpAction): boolean;
  callActionMustExecute(action: FunctionCallAction): boolean;
}>;
