import { ifControl, type IfControl } from "./if.js";
import {
  loopContinueControl,
  loopControl,
  type LoopContinueControl,
  type LoopControl
} from "./loop.js";
import { returnControl, type ReturnControl } from "./return.js";
import { switchControl, type SwitchControl } from "./switch.js";

export {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl
};
export type {
  BranchHint,
  ControlBase
} from "./definition.js";
export type {
  IfControl,
  IfControlArgs
} from "./if.js";
export type {
  LoopContinueControl,
  LoopContinueControlArgs
} from "./loop.js";
export type {
  LoopCarriedValue,
  LoopControl,
  LoopControlArgs
} from "./loop.js";
export type {
  ReturnControl,
  ReturnControlArgs,
  ReturnSource
} from "./return.js";
export {
  maxSwitchMatch,
  type SwitchCase,
  type SwitchControl,
  type SwitchControlArgs
} from "./switch.js";

export type StructuredControl =
  | IfControl
  | SwitchControl
  | LoopControl;

export type TerminalControl =
  | LoopContinueControl
  | ReturnControl;

export type Control = StructuredControl | TerminalControl;
