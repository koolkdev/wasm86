import { finishControl, type FinishControl } from "./finish.js";
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
  finishControl,
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl
};
export type {
  ControlBase,
  ControlEmitTarget
} from "./definition.js";
export type {
  DispatchFinish,
  ExitFinish,
  Finish,
  FinishControl,
  FinishControlArgs
} from "./finish.js";
export type {
  BranchHint,
  IfControl,
  IfControlArgs
} from "./if.js";
export type {
  LoopContinueControl,
  LoopContinueControlArgs
} from "./loop.js";
export type {
  LoopCarriedCell,
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
  | FinishControl
  | ReturnControl;

export type Control = StructuredControl | TerminalControl;
