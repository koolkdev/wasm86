import { ifControl } from "./if.js";
import { loopContinueControl, loopControl } from "./loop.js";
import { returnControl } from "./return.js";
import { switchControl } from "./switch.js";
import type {
  ControlCompletionContext,
  ControlDefinition,
  DerivedControlDescription
} from "./definition.js";
import type { Region } from "../region.js";

export { ifControl, loopContinueControl, loopControl, returnControl, switchControl };
export type {
  BranchHint,
  ControlCompletionContext,
  ControlDefinition,
  ControlNodeBase,
  DerivedControlDescription
} from "./definition.js";
export type { IfControl, IfControlArgs } from "./if.js";
export type { LoopContinueControl, LoopContinueControlArgs } from "./loop.js";
export type { LoopCarriedValue, LoopControl, LoopControlArgs } from "./loop.js";
export type { ReturnControl, ReturnControlArgs, ReturnSource } from "./return.js";
export {
  maxSwitchMatch,
  type SwitchCase,
  type SwitchControl,
  type SwitchControlArgs
} from "./switch.js";

const declaredControlDefinitions = {
  if: ifControl,
  switch: switchControl,
  loop: loopControl,
  loopContinue: loopContinueControl,
  return: returnControl
} as const;

type DeclaredControlDefinition =
  (typeof declaredControlDefinitions)[keyof typeof declaredControlDefinitions];

type ControlDefinitions = {
  [Definition in DeclaredControlDefinition as Definition["kind"]]: Definition;
};

const controlDefinitions: ControlDefinitions = declaredControlDefinitions;

type ControlKind = keyof ControlDefinitions;

type ControlsByKind = {
  [Kind in ControlKind]: ReturnType<ControlDefinitions[Kind]["create"]>;
};

export type Control = ControlsByKind[ControlKind];

type ControlMechanisms = {
  [Kind in ControlKind]: Pick<
    ControlDefinition<unknown, ControlsByKind[Kind]>,
    "describe" | "mapBodies" | "completes"
  >;
};

const controlMechanisms: ControlMechanisms = controlDefinitions;

export function describeControl(control: Control): DerivedControlDescription {
  return describeControlKind(control.kind, control);
}

export function mapControlBodies(control: Control, map: (body: Region) => Region): Control {
  return mapControlBodiesKind(control.kind, control, map);
}

export function controlCompletes(control: Control, context: ControlCompletionContext): boolean {
  return controlKindCompletes(control.kind, control, context);
}

function describeControlKind<Kind extends ControlKind>(
  kind: Kind,
  control: ControlsByKind[Kind]
): DerivedControlDescription {
  return controlMechanisms[kind].describe(control);
}

function mapControlBodiesKind<Kind extends ControlKind>(
  kind: Kind,
  control: ControlsByKind[Kind],
  map: (body: Region) => Region
): ControlsByKind[Kind] {
  return controlMechanisms[kind].mapBodies(control, map);
}

function controlKindCompletes<Kind extends ControlKind>(
  kind: Kind,
  control: ControlsByKind[Kind],
  context: ControlCompletionContext
): boolean {
  return controlMechanisms[kind].completes(control, context);
}
