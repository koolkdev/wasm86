import { assert } from "#common/assert.js";
import type { CpuException } from "#x86/exceptions.js";
import type { Body } from "./block.js";
import { opAccess, type IrOp, type StateWriteOp } from "./ops.js";
import type { StateChannel } from "./slots.js";
import { type ValueId, type ValueTable } from "./values.js";

// Reports to the host; the action emitter owns the numeric encoding.
export type HostExitReason = "hostTrap" | "unsupported" | "segmentLoad";

export type IrExit =
  | Readonly<{ class: "cpuException"; exception: CpuException<ValueId> }>
  | Readonly<{ class: "host"; reason: HostExitReason; payload?: ValueId }>;

export type OpAction = Readonly<{ kind: "op"; op: IrOp; output?: ValueId }>;

export type BranchHint = "unlikely" | "likely";

export type IfAction = Readonly<{
  kind: "if";
  condition: ValueId;
  hint?: BranchHint;
  thenBody: Body;
  elseBody?: Body;
}>;

// Selects one body by selector match, the default when none matches; the
// selected body's fallthrough result becomes `output`. The emitter derives
// the dense br_table from the match values.
export type SwitchAction = Readonly<{
  kind: "switch";
  selector: ValueId;
  // Required until a control-only switch has a producer.
  output: ValueId;
  cases: readonly SwitchCase[];
  defaultBody: Body;
}>;

export type SwitchCase = Readonly<{ match: number; body: Body }>;

// Matches lower to a dense br_table, so they stay byte-sized.
export const maxSwitchMatch = 255;

// One loop-carried cell: a local seeded at loop entry, read inside the body
// as the opaque `loopInput` leaf, rewritten at each back edge. A channel
// names the state it stands in for while the loop runs; a channel-less cell
// is a plain loop-carried temporary.
export type LoopCarriedCell = Readonly<{
  channel?: StateChannel;
  seed: ValueId;
  loopInput: ValueId;
}>;

// Runs its body until the body falls through; `loopContinue` actions inside the
// body take the back edge. Loop fallthrough is the body's fallthrough.
export type LoopAction = Readonly<{
  kind: "loop";
  carried: readonly LoopCarriedCell[];
  body: Body;
}>;

// The back edge: rewrites the carried cells (updates aligned with the
// carried list) and re-enters the loop body. Completes a body like finish.
export type LoopContinueAction = Readonly<{
  kind: "loopContinue";
  updates: readonly ValueId[];
}>;

export type Finish =
  | Readonly<{
      kind: "dispatch";
      targetEip: ValueId;
    }>
  | Readonly<{
      kind: "exit";
      exit: IrExit;
    }>;

export type FinishAction = Readonly<{
  kind: "finish";
  finish: Finish;
}>;

export type ExitFinish = Extract<Finish, { kind: "exit" }>;

export type DispatchFinish = Extract<Finish, { kind: "dispatch" }>;

export type Action =
  | OpAction
  | IfAction
  | SwitchAction
  | LoopAction
  | LoopContinueAction
  | FinishAction;

export type StateWriteAction = Readonly<{ kind: "op"; op: StateWriteOp }>;

export function createOpAction(values: ValueTable, op: IrOp): OpAction {
  const access = opAccess(op);

  if (access.valueOutput === undefined) {
    return { kind: "op", op };
  }

  assert(access.valueOutput.type === "i32", `${op.kind} op action output type is not supported`);

  return {
    kind: "op",
    output: values.addActionOutput(access.valueOutput.bounds),
    op
  };
}

// A control action completes if every selectable body escapes; a
// result-bearing body does not complete — it falls through to the join.
export function actionCompletes(action: Action): boolean {
  switch (action.kind) {
    case "op":
      return false;
    case "if":
      return action.elseBody !== undefined &&
        bodyCompletes(action.thenBody) &&
        bodyCompletes(action.elseBody);
    case "switch":
      return action.cases.every((switchCase) => bodyCompletes(switchCase.body)) &&
        bodyCompletes(action.defaultBody);
    case "loop":
      // A loop exits on body fallthrough, so it never completes its owner.
      return false;
    case "loopContinue":
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
