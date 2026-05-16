import type {
  IrOp,
  StorageRef,
  ValueRef,
  VarRef
} from "./types.js";

export type IrValueUseRole = "condition" | "value";
export type IrStorageUseRole = "read" | "write";
export type IrResultSideEffect = "none" | "storageRead";

export type IrValueUse = Readonly<{
  value: ValueRef;
  role: IrValueUseRole;
}>;

export type IrStorageUse = Readonly<{
  storage: StorageRef;
  role: IrStorageUseRole;
}>;

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
    case "flags.condition":
      return { kind: "value", dst: op.dst, sideEffect: "none" };
    case "set":
    case "memory.guard":
    case "flags.set":
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
    case "flags.set":
    case "flags.condition":
      return false;
  }

  return assertNever(op);
}

export function irOpValueUses(op: IrOp): readonly IrValueUse[] {
  const uses: IrValueUse[] = [];

  visitIrOpValueRefs(op, (value, role) => {
    uses.push({ value, role });
  });
  return uses;
}

export function visitIrOpValueRefs(
  op: IrOp,
  visit: (value: ValueRef, role: IrValueUseRole) => void
): void {
  switch (op.op) {
    case "get":
      visitIrStorageValueRefs(op.source, visit);
      return;
    case "set":
      visitIrStorageValueRefs(op.target, visit);
      visit(op.value, "value");
      return;
    case "memory.guard":
      visit(op.address, "value");
      for (const write of op.faultRollback ?? []) {
        visit(write.value, "value");
      }
      return;
    case "address":
    case "value.const":
      return;
    case "value.binary":
      visit(op.a, "value");
      visit(op.b, "value");
      return;
    case "value.unary":
      visit(op.value, "value");
      return;
    case "value.select":
      visit(op.condition, "condition");
      visit(op.whenTrue, "value");
      visit(op.whenFalse, "value");
      return;
    case "flags.set":
      for (const value of Object.values(op.inputs)) {
        visit(value, "value");
      }
      return;
    case "flags.condition":
    case "next":
      return;
    case "jump":
      visit(op.target, "value");
      return;
    case "conditionalJump":
      visit(op.condition, "condition");
      visit(op.taken, "value");
      visit(op.notTaken, "value");
      return;
    case "hostTrap":
      visit(op.vector, "value");
      return;
  }

  assertNever(op);
}

export function irOpStorageUses(op: IrOp): readonly IrStorageUse[] {
  const uses: IrStorageUse[] = [];

  visitIrOpStorageRefs(op, (storage, role) => {
    uses.push({ storage, role });
  });
  return uses;
}

export function irOpStorageReads(op: IrOp): readonly StorageRef[] {
  return irOpStorageUses(op)
    .filter((use) => use.role === "read")
    .map((use) => use.storage);
}

export function irOpStorageWrites(op: IrOp): readonly StorageRef[] {
  return irOpStorageUses(op)
    .filter((use) => use.role === "write")
    .map((use) => use.storage);
}

export function visitIrOpStorageRefs(
  op: IrOp,
  visit: (storage: StorageRef, role: IrStorageUseRole) => void
): void {
  switch (op.op) {
    case "get":
      visit(op.source, "read");
      return;
    case "set":
      visit(op.target, "write");
      return;
    case "memory.guard":
      return;
    case "address":
    case "value.const":
    case "value.binary":
    case "value.unary":
    case "value.select":
    case "flags.set":
    case "flags.condition":
    case "next":
    case "jump":
    case "conditionalJump":
    case "hostTrap":
      return;
  }

  assertNever(op);
}

export function visitIrStorageValueRefs(
  storage: StorageRef,
  visit: (value: ValueRef, role: IrValueUseRole) => void
): void {
  if (storage.kind === "mem") {
    visit(storage.address, "value");
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled IR op semantics: ${JSON.stringify(value)}`);
}
