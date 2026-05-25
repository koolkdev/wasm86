import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import { u32 } from "#x86/state/cpu-state.js";

export type JitConstExpr = Extract<IrValueExpr, { kind: "const" }>;
export type JitMemoryGuardExprOp = Extract<IrExprOp, { op: "memory.guard" }> & Readonly<{
  faultEip: number;
}>;
export type JitNextExprOp = Extract<IrExprOp, { op: "next" }> & Readonly<{
  target: JitConstExpr;
}>;
export type JitHostTrapExprOp = Extract<IrExprOp, { op: "hostTrap" }> & Readonly<{
  visibleEip: number;
}>;
export type JitJumpExprOp = Extract<IrExprOp, { op: "jump" }>;
export type JitConditionalJumpExprOp = Extract<IrExprOp, { op: "conditionalJump" }>;

export type JitBoundExprOp =
  | Exclude<IrExprOp, Extract<IrExprOp, { op: "memory.guard" | "next" | "hostTrap" }>>
  | JitMemoryGuardExprOp
  | JitNextExprOp
  | JitHostTrapExprOp;

export type JitBoundExprBlock = readonly JitBoundExprOp[];

export type JitBoundExpressionContext = Readonly<{
  eip: number;
  nextEip: number;
}>;

export function buildJitBoundExpressionBlock(
  block: IrExprBlock,
  context: JitBoundExpressionContext
): JitBoundExprBlock {
  const bound = block.map((op, opIndex) =>
    bindJitExpressionOp(op, opIndex, context)
  );

  validateJitBoundExpressionBlock(bound);
  return bound;
}

export function validateJitBoundExpressionBlock(
  block: JitBoundExprBlock
): void {
  for (let opIndex = 0; opIndex < block.length; opIndex += 1) {
    const op = block[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT expression op: ${opIndex}`);
    }

    validateJitBoundExpressionOp(op, opIndex);
  }
}

function bindJitExpressionOp(
  op: IrExprOp,
  opIndex: number,
  context: JitBoundExpressionContext
): JitBoundExprOp {
  switch (op.op) {
    case "memory.guard":
      assertJitBoundValue(op.address, opIndex);
      return { ...op, faultEip: u32(context.eip) };
    case "next":
      return { ...op, target: const32(context.nextEip) };
    case "hostTrap":
      assertJitBoundValue(op.vector, opIndex);
      return { ...op, visibleEip: u32(context.nextEip) };
    case "let32":
      assertJitBoundValue(op.value, opIndex);
      return op;
    case "set":
      assertJitBoundStorage(op.target, opIndex);
      assertJitBoundValue(op.value, opIndex);
      return op;
    case "flags.set":
      Object.values(op.inputs).forEach((value) => assertJitBoundValue(value, opIndex));
      return op;
    case "flags.write":
      Object.values(op.cells).forEach((cell) => {
        if (cell?.kind === "expr") {
          assertJitBoundValue(cell.value, opIndex);
        }
      });
      Object.values(op.conditions ?? {}).forEach((value) => {
        if (value !== undefined) {
          assertJitBoundValue(value, opIndex);
        }
      });
      return op;
    case "jump":
      assertJitBoundValue(op.target, opIndex);
      return op;
    case "conditionalJump":
      assertJitBoundValue(op.condition, opIndex);
      assertJitBoundValue(op.taken, opIndex);
      assertJitBoundValue(op.notTaken, opIndex);
      return op;
  }
}

function validateJitBoundExpressionOp(op: JitBoundExprOp, opIndex: number): void {
  switch (op.op) {
    case "memory.guard":
      assertJitBoundValue(op.address, opIndex);
      return;
    case "next":
      return;
    case "hostTrap":
      assertJitBoundValue(op.vector, opIndex);
      return;
    case "let32":
      assertJitBoundValue(op.value, opIndex);
      return;
    case "set":
      assertJitBoundStorage(op.target, opIndex);
      assertJitBoundValue(op.value, opIndex);
      return;
    case "flags.set":
      Object.values(op.inputs).forEach((value) => assertJitBoundValue(value, opIndex));
      return;
    case "flags.write":
      Object.values(op.cells).forEach((cell) => {
        if (cell?.kind === "expr") {
          assertJitBoundValue(cell.value, opIndex);
        }
      });
      Object.values(op.conditions ?? {}).forEach((value) => {
        if (value !== undefined) {
          assertJitBoundValue(value, opIndex);
        }
      });
      return;
    case "jump":
      assertJitBoundValue(op.target, opIndex);
      return;
    case "conditionalJump":
      assertJitBoundValue(op.condition, opIndex);
      assertJitBoundValue(op.taken, opIndex);
      assertJitBoundValue(op.notTaken, opIndex);
      return;
  }
}

function assertJitBoundStorage(storage: IrStorageExpr, opIndex: number): void {
  switch (storage.kind) {
    case "operand":
      throw new Error(`JIT expression op ${opIndex} must not contain source-local operand storage`);
    case "mem":
      assertJitBoundValue(storage.address, opIndex);
      return;
    case "reg":
      return;
  }
}

function assertJitBoundValue(value: IrValueExpr, opIndex: number): void {
  switch (value.kind) {
    case "nextEip":
      throw new Error(`JIT expression op ${opIndex} must not contain nextEip refs`);
    case "address":
      throw new Error(`JIT expression op ${opIndex} must not contain source-local address refs`);
    case "source":
      assertJitBoundStorage(value.source, opIndex);
      return;
    case "value.binary":
      assertJitBoundValue(value.a, opIndex);
      assertJitBoundValue(value.b, opIndex);
      return;
    case "value.unary":
      assertJitBoundValue(value.value, opIndex);
      return;
    case "value.select":
      assertJitBoundValue(value.condition, opIndex);
      assertJitBoundValue(value.whenTrue, opIndex);
      assertJitBoundValue(value.whenFalse, opIndex);
      return;
    case "value.project":
      assertJitBoundValue(value.value, opIndex);
      return;
    case "value.compare":
      assertJitBoundValue(value.a, opIndex);
      assertJitBoundValue(value.b, opIndex);
      return;
    case "var":
    case "const":
    case "flags.condition":
      return;
  }
}

function const32(value: number): JitConstExpr {
  return { kind: "const", type: "i32", value: u32(value) };
}
