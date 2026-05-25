import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { VarRef } from "#x86/ir/model/types.js";

export type InterpreterExpressionOptimizerOptions = Readonly<{
  canInlineGet(source: IrStorageExpr): boolean;
  storageMayAlias(write: IrStorageExpr, read: IrStorageExpr): boolean;
}>;

type SourceExpr = Extract<IrValueExpr, { kind: "source" }>;

export function optimizeInterpreterExpressionBlock(
  block: IrExprBlock,
  options: InterpreterExpressionOptimizerOptions
): IrExprBlock {
  const useCounts = countVarUses(block);
  const bindings = new Map<number, SourceExpr>();
  const optimized: IrExprOp[] = [];

  for (let opIndex = 0; opIndex < block.length; opIndex += 1) {
    const op = block[opIndex];

    if (op === undefined) {
      throw new Error(`missing interpreter expression op: ${opIndex}`);
    }

    if (
      op.op === "let32" &&
      op.value.kind === "source" &&
      remainingUses(useCounts, op.dst.id) === 1 &&
      options.canInlineGet(op.value.source) &&
      sourceReadUseAcceptsInlineSource(block, op.dst, opIndex) &&
      !sourceReadWouldCrossAliasBarrier(block, op.dst, op.value.source, opIndex, options)
    ) {
      bindings.set(op.dst.id, op.value);
      continue;
    }

    optimized.push(rewriteOp(op, bindings));
  }

  return optimized;
}

function sourceReadUseAcceptsInlineSource(
  block: IrExprBlock,
  dst: VarRef,
  opIndex: number
): boolean {
  for (let index = opIndex + 1; index < block.length; index += 1) {
    const op = block[index];

    if (op === undefined) {
      throw new Error(`missing interpreter expression op: ${index}`);
    }

    if (opUsesVar(op, dst.id)) {
      return op.op !== "flags.set";
    }
  }

  return false;
}

function sourceReadWouldCrossAliasBarrier(
  block: IrExprBlock,
  dst: VarRef,
  readStorage: IrStorageExpr,
  opIndex: number,
  options: InterpreterExpressionOptimizerOptions
): boolean {
  for (let index = opIndex + 1; index < block.length; index += 1) {
    const op = block[index];

    if (op === undefined) {
      throw new Error(`missing interpreter expression op: ${index}`);
    }

    if (opUsesVar(op, dst.id)) {
      return false;
    }

    if (opWriteStorages(op).some((writeStorage) =>
      options.storageMayAlias(writeStorage, readStorage)
    )) {
      return true;
    }
  }

  return false;
}

function rewriteOp(
  op: IrExprOp,
  bindings: Map<number, SourceExpr>
): IrExprOp {
  switch (op.op) {
    case "let32":
      return { ...op, value: rewriteValue(op.value, bindings) };
    case "set":
      return {
        ...op,
        target: rewriteStorage(op.target, bindings),
        value: rewriteValue(op.value, bindings)
      };
    case "memory.guard":
      return { ...op, address: rewriteValue(op.address, bindings) };
    case "flags.set":
      return op;
    case "flags.write":
      return {
        ...op,
        cells: Object.fromEntries(
          Object.entries(op.cells).map(([flag, cell]) => [
            flag,
            cell?.kind === "expr" ? { kind: "expr", value: rewriteValue(cell.value, bindings) } : cell
          ])
        ),
        ...(op.conditions === undefined
          ? {}
          : {
              conditions: Object.fromEntries(
                Object.entries(op.conditions).map(([cc, value]) => [cc, rewriteValue(value, bindings)])
              )
            })
      };
    case "jump":
      return { ...op, target: rewriteValue(op.target, bindings) };
    case "conditionalJump":
      return {
        ...op,
        condition: rewriteValue(op.condition, bindings),
        taken: rewriteValue(op.taken, bindings),
        notTaken: rewriteValue(op.notTaken, bindings)
      };
    case "hostTrap":
      return { ...op, vector: rewriteValue(op.vector, bindings) };
    case "next":
      return op;
  }
}

function rewriteValue(
  value: IrValueExpr,
  bindings: Map<number, SourceExpr>
): IrValueExpr {
  switch (value.kind) {
    case "var": {
      const binding = bindings.get(value.id);

      if (binding === undefined) {
        return value;
      }

      bindings.delete(value.id);
      return binding;
    }
    case "source":
      return { ...value, source: rewriteStorage(value.source, bindings) };
    case "value.binary":
      return {
        ...value,
        a: rewriteValue(value.a, bindings),
        b: rewriteValue(value.b, bindings)
      };
    case "value.unary":
      return { ...value, value: rewriteValue(value.value, bindings) };
    case "value.select":
      return {
        ...value,
        condition: rewriteValue(value.condition, bindings),
        whenTrue: rewriteValue(value.whenTrue, bindings),
        whenFalse: rewriteValue(value.whenFalse, bindings)
      };
    case "value.project":
      return { ...value, value: rewriteValue(value.value, bindings) };
    case "value.compare":
      return {
        ...value,
        a: rewriteValue(value.a, bindings),
        b: rewriteValue(value.b, bindings)
      };
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return value;
  }
}

function rewriteStorage(
  storage: IrStorageExpr,
  bindings: Map<number, SourceExpr>
): IrStorageExpr {
  switch (storage.kind) {
    case "mem":
      return { ...storage, address: rewriteValue(storage.address, bindings) };
    case "operand":
    case "reg":
      return storage;
  }
}

function countVarUses(block: IrExprBlock): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();

  for (const op of block) {
    visitOpValues(op, (value) => {
      if (value.kind === "var") {
        counts.set(value.id, remainingUses(counts, value.id) + 1);
      }
    });
  }

  return counts;
}

function opUsesVar(op: IrExprOp, id: number): boolean {
  let found = false;

  visitOpValues(op, (value) => {
    found ||= value.kind === "var" && value.id === id;
  });

  return found;
}

function opWriteStorages(op: IrExprOp): readonly IrStorageExpr[] {
  return op.op === "set" ? [op.target] : [];
}

function visitOpValues(
  op: IrExprOp,
  visit: (value: IrValueExpr) => void
): void {
  switch (op.op) {
    case "let32":
      visitValue(op.value, visit);
      return;
    case "set":
      visitStorage(op.target, visit);
      visitValue(op.value, visit);
      return;
    case "memory.guard":
      visitValue(op.address, visit);
      return;
    case "flags.set":
      for (const value of Object.values(op.inputs)) {
        visitValue(value, visit);
      }
      return;
    case "flags.write":
      for (const cell of Object.values(op.cells)) {
        if (cell?.kind === "expr") {
          visitValue(cell.value, visit);
        }
      }

      for (const value of Object.values(op.conditions ?? {})) {
        if (value !== undefined) {
          visitValue(value, visit);
        }
      }
      return;
    case "jump":
      visitValue(op.target, visit);
      return;
    case "conditionalJump":
      visitValue(op.condition, visit);
      visitValue(op.taken, visit);
      visitValue(op.notTaken, visit);
      return;
    case "hostTrap":
      visitValue(op.vector, visit);
      return;
    case "next":
      return;
  }
}

function visitValue(
  value: IrValueExpr,
  visit: (value: IrValueExpr) => void
): void {
  visit(value);

  switch (value.kind) {
    case "source":
      visitStorage(value.source, visit);
      return;
    case "value.binary":
      visitValue(value.a, visit);
      visitValue(value.b, visit);
      return;
    case "value.unary":
      visitValue(value.value, visit);
      return;
    case "value.select":
      visitValue(value.condition, visit);
      visitValue(value.whenTrue, visit);
      visitValue(value.whenFalse, visit);
      return;
    case "value.project":
      visitValue(value.value, visit);
      return;
    case "value.compare":
      visitValue(value.a, visit);
      visitValue(value.b, visit);
      return;
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return;
  }
}

function visitStorage(
  storage: IrStorageExpr,
  visit: (value: IrValueExpr) => void
): void {
  if (storage.kind === "mem") {
    visitValue(storage.address, visit);
  }
}

function remainingUses(useCounts: ReadonlyMap<number, number>, id: number): number {
  return useCounts.get(id) ?? 0;
}
