import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { Body } from "./block.js";
import type { IrOp, StateWriteOp } from "./ops.js";
import type { ValueId } from "./values.js";

// Reports to the host; the action emitter owns the numeric encoding.
export type ActionExitReason =
  | "hostTrap"
  | "unsupported"
  | "decodeFault"
  | "memoryReadFault"
  | "memoryWriteFault";

export type OpAction = Readonly<{ kind: "op"; op: IrOp; output?: ValueId }>;

export type GuardMemoryAction = Readonly<{
  kind: "guardMemory";
  address: ValueId;
  byteLength: number;
  access: MemoryAccessKind;
  faultBody: Body;
}>;

export type IfAction = Readonly<{
  kind: "if";
  condition: ValueId;
  thenBody: Body;
  elseBody?: Body;
}>;

export type Finish =
  | Readonly<{
      kind: "dispatch";
      targetEip: ValueId;
    }>
  | Readonly<{
      kind: "exit";
      reason: ActionExitReason;
      payload?: ValueId;
    }>;

export type FinishAction = Readonly<{
  kind: "finish";
  finish: Finish;
}>;

export type ExitFinish = Extract<Finish, { kind: "exit" }>;

export type DispatchFinish = Extract<Finish, { kind: "dispatch" }>;

export type Action =
  | OpAction
  | GuardMemoryAction
  | IfAction
  | FinishAction;

export type StateWriteAction = Readonly<{ kind: "op"; op: StateWriteOp }>;

export function actionCompletes(action: Action): boolean {
  switch (action.kind) {
    case "op":
    case "guardMemory":
      return false;
    case "if":
      return action.elseBody !== undefined &&
        bodyCompletes(action.thenBody) &&
        bodyCompletes(action.elseBody);
    case "finish":
      return true;
  }
}

export function bodyCompletes(body: Body): boolean {
  return bodyFinal(body) !== undefined;
}

export function bodyFinal(body: Body): Action | undefined {
  const last = body.actions[body.actions.length - 1];

  return last !== undefined && actionCompletes(last) ? last : undefined;
}
