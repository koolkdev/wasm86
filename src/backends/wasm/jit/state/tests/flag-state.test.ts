import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import type { OperandWidth } from "#x86/isa/types.js";
import { IR_ALU_FLAGS } from "#x86/ir/model/flag-effects.js";
import type { FlagName } from "#x86/ir/model/flags.js";
import type { ScalarCompareOp } from "#backends/wasm/jit/ir/expressions/types.js";
import {
  exprBinary,
  exprCompare,
  exprConst,
  exprInput,
  exprProject,
  exprTestBit
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import { exprDependencies } from "#backends/wasm/jit/ir/expressions/dependencies.js";
import type { ExprRef } from "#backends/wasm/jit/ir/expressions/types.js";
import {
  FlagState,
  type FlagCell,
  type SemanticFlagWrite
} from "#backends/wasm/jit/state/flag-state.js";

test("JIT flag state initializes keyed per-flag input cells", () => {
  const state = FlagState.initial();

  deepStrictEqual(
    state.cells(),
    IR_ALU_FLAGS.map((flag) => ({ flag, cell: inputCell(flag) }))
  );
  deepStrictEqual(state.read("ZF"), inputCell("ZF"));
  deepStrictEqual(state.condition("E"), exprInput({ kind: "flag", flag: "ZF" }));
});

test("JIT flag state reads written, preserved, input, and undefined cells", () => {
  const state = FlagState.initial()
    .apply({ cells: { CF: exprCell(exprConst(1)), AF: undefCell() } })
    .apply({ cells: { ZF: exprCell(exprConst(0)) } });

  deepStrictEqual(state.read("CF"), exprCell(exprConst(1)));
  deepStrictEqual(state.read("ZF"), exprCell(exprConst(0)));
  deepStrictEqual(state.read("PF"), inputCell("PF"));
  deepStrictEqual(state.read("AF"), undefCell());
});

test("JIT flag state cells returns keyed entries for all arithmetic flags", () => {
  const state = FlagState.initial().apply({
    cells: {
      CF: exprCell(exprConst(1)),
      ZF: exprCell(exprConst(0))
    }
  });

  deepStrictEqual(
    state.cells(),
    IR_ALU_FLAGS.map((flag) => ({
      flag,
      cell: flag === "CF"
        ? exprCell(exprConst(1))
        : flag === "ZF"
          ? exprCell(exprConst(0))
          : inputCell(flag)
    }))
  );
});

test("JIT flag state partial writes preserve unwritten flag cells", () => {
  const initial = FlagState.initial().apply({ cells: { CF: exprCell(exprConst(1)) } });
  const next = initial.apply({ cells: { ZF: exprCell(exprConst(1)) } });

  deepStrictEqual(next.read("CF"), exprCell(exprConst(1)));
  deepStrictEqual(next.read("ZF"), exprCell(exprConst(1)));
  deepStrictEqual(next.read("PF"), inputCell("PF"));
  deepStrictEqual(initial.read("ZF"), inputCell("ZF"));
});

test("JIT flag state canonicalizes cell and direct condition expressions", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const direct = compare(32, "eq", eax, ebx);
  const state = FlagState.initial().apply({
    cells: {
      ZF: exprCell(exprProject(32, eax))
    },
    conditions: {
      E: exprProject(32, direct)
    }
  });

  deepStrictEqual(state.read("ZF"), exprCell(eax));
  deepStrictEqual(state.condition("E"), direct);
});

test("ADD and SUB semantic writes update every arithmetic flag cell", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");

  for (const write of [addFlagWrite(32, eax, ebx), subFlagWrite(32, eax, ebx)]) {
    const state = FlagState.initial().apply(write);

    for (const flag of IR_ALU_FLAGS) {
      strictEqual(state.read(flag).kind, "expr");
    }
  }
});

test("CMP semantic write contains flag cells and no destination result payload", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const write = cmpFlagWrite(32, eax, ebx);
  const state = FlagState.initial().apply(write);

  strictEqual("result" in write, false);
  deepStrictEqual(Object.keys(write.cells).sort(), [...IR_ALU_FLAGS].sort());
  strictEqual(state.read("ZF").kind, "expr");
});

test("TEST semantic write uses logic cells and marks AF undefined", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const state = FlagState.initial().apply(testFlagWrite(32, eax, ebx));

  deepStrictEqual(state.read("CF"), exprCell(exprConst(0)));
  deepStrictEqual(state.read("OF"), exprCell(exprConst(0)));
  deepStrictEqual(state.read("AF"), undefCell());
  strictEqual(state.read("ZF").kind, "expr");
  strictEqual(state.read("SF").kind, "expr");
  strictEqual(state.read("PF").kind, "expr");
});

test("INC and DEC semantic writes preserve CF", () => {
  const eax = inputReg("eax");
  const initial = FlagState.initial().apply({ cells: { CF: exprCell(exprConst(1)) } });

  for (const write of [incFlagWrite(8, eax), decFlagWrite(8, eax)]) {
    const state = initial.apply(write);

    deepStrictEqual(state.read("CF"), exprCell(exprConst(1)));
    for (const flag of ["PF", "AF", "ZF", "SF", "OF"] as const) {
      strictEqual(state.read(flag).kind, "expr");
    }
  }
});

test("parity flag formulas consume only the low byte", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const state = FlagState.initial().apply(testFlagWrite(32, eax, ebx));

  deepStrictEqual(exprDependencies(exprCellValue(state.read("PF"))), [
    { kind: "reg", reg: "eax", mask: 0xff },
    { kind: "reg", reg: "ebx", mask: 0xff }
  ]);
});

test("sign and overflow formulas consume the operation sign bit", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");

  for (const width of [8, 16, 32] as const) {
    const state = FlagState.initial().apply(addFlagWrite(width, eax, ebx));
    const left = project(width, eax);
    const right = project(width, ebx);
    const result = project(width, binary("add", left, right));
    const signBit = width - 1;
    const overflow = testBit(
      binary("and", binary("xor", left, result), binary("xor", right, result)),
      signBit
    );

    deepStrictEqual(exprCellValue(state.read("SF")), testBit(result, signBit));
    deepStrictEqual(exprCellValue(state.read("OF")), overflow);
  }
});

test("direct conditions are used for optimized CMP condition cases only", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const state = FlagState.initial().apply(cmpFlagWrite(16, eax, ebx));
  const left = project(16, eax);
  const right = project(16, ebx);

  deepStrictEqual(state.condition("E"), compare(16, "eq", left, right));
  deepStrictEqual(state.condition("NE"), compare(16, "ne", left, right));
  deepStrictEqual(state.condition("B"), compare(16, "lt_u", left, right));
  deepStrictEqual(state.condition("AE"), compare(16, "ge_u", left, right));
  deepStrictEqual(state.condition("BE"), compare(16, "le_u", left, right));
  deepStrictEqual(state.condition("A"), compare(16, "gt_u", left, right));
  deepStrictEqual(state.condition("L"), compare(16, "lt_s", left, right));
  deepStrictEqual(state.condition("GE"), compare(16, "ge_s", left, right));
  deepStrictEqual(state.condition("LE"), compare(16, "le_s", left, right));
  deepStrictEqual(state.condition("G"), compare(16, "gt_s", left, right));
  deepStrictEqual(state.condition("P"), exprCellValue(state.read("PF")));
});

test("missing direct conditions fall back to current flag-cell composition", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const state = FlagState.initial().apply({
    cells: logicFlagWrite(32, binary("and", eax, ebx)).cells,
    conditions: {
      E: exprConst(1)
    }
  });

  deepStrictEqual(state.condition("E"), exprConst(1));
  deepStrictEqual(state.condition("NE"), boolNot(exprCellValue(state.read("ZF"))));
  deepStrictEqual(state.condition("A"), binary(
    "and",
    boolNot(exprCellValue(state.read("CF"))),
    boolNot(exprCellValue(state.read("ZF")))
  ));
});

test("condition composition reads only the required flag cells", () => {
  const state = FlagState.initial();

  deepStrictEqual(exprDependencies(definedExpr(state.condition("A"))), [
    { kind: "flag", flag: "CF" },
    { kind: "flag", flag: "ZF" }
  ]);
  deepStrictEqual(exprDependencies(definedExpr(state.condition("L"))), [
    { kind: "flag", flag: "SF" },
    { kind: "flag", flag: "OF" }
  ]);
});

test("condition composition returns undefined when a required flag is undefined", () => {
  const state = FlagState.initial().apply({ cells: { ZF: undefCell() } });

  strictEqual(state.condition("E"), undefined);
  strictEqual(state.condition("A"), undefined);
});

test("later flag writes clear and replace stale direct conditions", () => {
  const eax = inputReg("eax");
  const ebx = inputReg("ebx");
  const cmpState = FlagState.initial().apply(cmpFlagWrite(32, eax, ebx));
  const oldDirectE = cmpState.condition("E");
  const partial = cmpState.apply({ cells: { CF: exprCell(exprConst(1)) } });

  deepStrictEqual(partial.condition("E"), exprCellValue(partial.read("ZF")));
  strictEqual(partial.condition("E") === oldDirectE, false);

  const replaced = partial.apply({
    cells: { ZF: exprCell(exprConst(0)) },
    conditions: { E: exprConst(1) }
  });

  deepStrictEqual(replaced.condition("E"), exprConst(1));
  deepStrictEqual(replaced.condition("B"), exprConst(1));
});

function inputCell(flag: FlagName): FlagCell {
  return { kind: "input", flag };
}

function exprCell(value: ExprRef): FlagCell {
  return { kind: "expr", value: canonicalizeExpr(value) };
}

function undefCell(): FlagCell {
  return { kind: "undef" };
}

function exprCellValue(cell: FlagCell): ExprRef {
  if (cell.kind !== "expr") {
    throw new Error(`expected expr flag cell, got ${cell.kind}`);
  }

  return cell.value;
}

function definedExpr(expr: ExprRef | undefined): ExprRef {
  if (expr === undefined) {
    throw new Error("expected defined expression");
  }

  return expr;
}

function inputReg(reg: "eax" | "ebx"): ExprRef {
  return exprInput({ kind: "reg", reg });
}

function addFlagWrite(width: OperandWidth, left: ExprRef, right: ExprRef): SemanticFlagWrite {
  const leftValue = project(width, left);
  const rightValue = project(width, right);
  const result = project(width, binary("add", leftValue, rightValue));

  return {
    cells: {
      ...zspCells(width, result),
      ...addCarryCells(width, leftValue, rightValue, result)
    }
  };
}

function subFlagWrite(width: OperandWidth, left: ExprRef, right: ExprRef): SemanticFlagWrite {
  const leftValue = project(width, left);
  const rightValue = project(width, right);
  const result = project(width, binary("sub", leftValue, rightValue));

  return {
    cells: {
      ...zspCells(width, result),
      ...subCarryCells(width, leftValue, rightValue, result)
    }
  };
}

function cmpFlagWrite(width: OperandWidth, left: ExprRef, right: ExprRef): SemanticFlagWrite {
  const leftValue = project(width, left);
  const rightValue = project(width, right);
  const write = subFlagWrite(width, leftValue, rightValue);

  return {
    cells: write.cells,
    conditions: {
      E: compare(width, "eq", leftValue, rightValue),
      NE: compare(width, "ne", leftValue, rightValue),
      B: compare(width, "lt_u", leftValue, rightValue),
      AE: compare(width, "ge_u", leftValue, rightValue),
      BE: compare(width, "le_u", leftValue, rightValue),
      A: compare(width, "gt_u", leftValue, rightValue),
      L: compare(width, "lt_s", leftValue, rightValue),
      GE: compare(width, "ge_s", leftValue, rightValue),
      LE: compare(width, "le_s", leftValue, rightValue),
      G: compare(width, "gt_s", leftValue, rightValue)
    }
  };
}

function testFlagWrite(width: OperandWidth, left: ExprRef, right: ExprRef): SemanticFlagWrite {
  return logicFlagWrite(width, binary("and", project(width, left), project(width, right)));
}

function logicFlagWrite(width: OperandWidth, result: ExprRef): SemanticFlagWrite {
  const projected = project(width, result);

  return {
    cells: {
      ...zspCells(width, projected),
      CF: exprCell(exprConst(0)),
      AF: undefCell(),
      OF: exprCell(exprConst(0))
    }
  };
}

function incFlagWrite(width: OperandWidth, input: ExprRef): SemanticFlagWrite {
  const left = project(width, input);
  const one = exprConst(1);
  const result = project(width, binary("add", left, one));
  const carry = addCarryCells(width, left, one, result);

  return {
    cells: {
      ...zspCells(width, result),
      AF: carry.AF,
      OF: carry.OF
    }
  };
}

function decFlagWrite(width: OperandWidth, input: ExprRef): SemanticFlagWrite {
  const left = project(width, input);
  const one = exprConst(1);
  const result = project(width, binary("sub", left, one));
  const carry = subCarryCells(width, left, one, result);

  return {
    cells: {
      ...zspCells(width, result),
      AF: carry.AF,
      OF: carry.OF
    }
  };
}

function zspCells(width: OperandWidth, result: ExprRef): Partial<Record<FlagName, FlagCell>> {
  return {
    ZF: exprCell(compare(width, "eq", result, exprConst(0))),
    SF: exprCell(testBit(result, width - 1)),
    PF: exprCell(parityFlag(result))
  };
}

function addCarryCells(
  width: OperandWidth,
  left: ExprRef,
  right: ExprRef,
  result: ExprRef
): Pick<Record<FlagName, FlagCell>, "CF" | "AF" | "OF"> {
  return {
    CF: exprCell(compare(width, "lt_u", result, left)),
    AF: exprCell(auxCarry(left, right, result)),
    OF: exprCell(testBit(binary("and", binary("xor", left, result), binary("xor", right, result)), width - 1))
  };
}

function subCarryCells(
  width: OperandWidth,
  left: ExprRef,
  right: ExprRef,
  result: ExprRef
): Pick<Record<FlagName, FlagCell>, "CF" | "AF" | "OF"> {
  return {
    CF: exprCell(compare(width, "lt_u", left, right)),
    AF: exprCell(auxCarry(left, right, result)),
    OF: exprCell(testBit(binary("and", binary("xor", left, right), binary("xor", left, result)), width - 1))
  };
}

function auxCarry(left: ExprRef, right: ExprRef, result: ExprRef): ExprRef {
  return testBit(binary("xor", binary("xor", left, right), result), 4);
}

function parityFlag(value: ExprRef): ExprRef {
  let parity = exprConst(1);

  for (let bit = 0; bit < 8; bit += 1) {
    parity = binary("xor", parity, testBit(value, bit));
  }

  return parity;
}

function boolNot(value: ExprRef): ExprRef {
  return binary("xor", value, exprConst(1));
}

function project(width: OperandWidth, value: ExprRef): ExprRef {
  return canonicalizeExpr(exprProject(width, value));
}

function testBit(value: ExprRef, bit: number): ExprRef {
  return canonicalizeExpr(exprTestBit(value, bit));
}

function compare(width: OperandWidth, op: ScalarCompareOp, left: ExprRef, right: ExprRef): ExprRef {
  return canonicalizeExpr(exprCompare(width, op, left, right));
}

function binary(op: "add" | "sub" | "and" | "or" | "xor", left: ExprRef, right: ExprRef): ExprRef {
  return canonicalizeExpr(exprBinary(op, left, right));
}
