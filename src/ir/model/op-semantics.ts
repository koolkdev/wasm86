import type {
  IrOp,
  VarRef
} from "./types.js";

export type IrResultSideEffect = "none" | "storageRead";

export type IrOpResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "value"; dst: VarRef; sideEffect: IrResultSideEffect }>;

export type IrTerminatorOp = Extract<IrOp, { op: "next" | "jump" | "conditionalJump" | "hostTrap" }>;

export function irOpResult(op: IrOp): IrOpResult {
  switch (op.op) {
    case "get":
      return { kind: "value", dst: op.dst, sideEffect: "storageRead" };
    case "address":
    case "value.const":
    case "value.binary":
    case "value.unary":
    case "value.select":
    case "value.project":
    case "value.compare":
    case "flags.condition":
      return { kind: "value", dst: op.dst, sideEffect: "none" };
    case "set":
    case "memory.guard":
    case "flags.write":
    case "next":
    case "jump":
    case "conditionalJump":
    case "hostTrap":
      return { kind: "none" };
  }

  return assertNever(op);
}

export function irOpDst(op: IrOp): VarRef | undefined {
  const result = irOpResult(op);

  return result.kind === "value" ? result.dst : undefined;
}

export function irOpIsTerminator(op: IrOp): op is IrTerminatorOp {
  switch (op.op) {
    case "next":
    case "jump":
    case "conditionalJump":
    case "hostTrap":
      return true;
    case "get":
    case "set":
    case "memory.guard":
    case "address":
    case "value.const":
    case "value.binary":
    case "value.unary":
    case "value.select":
    case "value.project":
    case "value.compare":
    case "flags.write":
    case "flags.condition":
      return false;
  }

  return assertNever(op);
}

function assertNever(value: never): never {
  throw new Error(`unhandled IR op semantics: ${JSON.stringify(value)}`);
}
