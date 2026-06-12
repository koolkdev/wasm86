import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { buildIr } from "#ir/build/builder.js";
import { x86Flags } from "#x86/flags.js";
import type { X86Flag } from "#x86/flags.js";
import { irOpDst } from "#ir/model/op-semantics.js";
import type {
  IrBinaryOperator,
  IrBlock,
  IrCompareOperator,
  IrFlagWrite,
  IrFlagWriteOp,
  IrOp,
  IrUnaryOperator,
  ValueRef
} from "#ir/model/types.js";
import { validateIrBlock } from "#ir/passes/validator.js";
import type { OperandWidth } from "#x86/types.js";
import {
  buildAddResultAndFlags,
  buildCmpFlags,
  buildDecFlags,
  buildIncFlags,
  buildLogicResultAndFlags,
  buildNegFlags,
  buildSubResultAndFlags,
  buildTestFlags
} from "#x86/semantics/flag-helpers.js";

test("ADD and SUB helpers write every arithmetic flag cell", () => {
  for (const helper of [buildAddResultAndFlags, buildSubResultAndFlags]) {
    const block = buildHelperIr((s) => {
      const left = s.get(s.operand(0), 32);
      const right = s.get(s.operand(1), 32);
      const { result, flags } = helper(s, { width: 32, left, right });

      s.set(s.operand(0), result);
      s.writeFlags(flags);
    });
    const write = flagWrite(block);

    deepStrictEqual(sortedKeys(write.cells), sortedFlags());
    strictEqual(write.conditions, undefined);
  }
});

test("CMP helper writes cells and sparse direct optimized conditions without result payload", () => {
  let flags: IrFlagWrite | undefined;
  const block = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);

    flags = buildCmpFlags(s, { width: 16, left, right });
    s.writeFlags(flags);
  });
  const write = flagWrite(block);

  strictEqual(flags === undefined ? false : "result" in flags, false);
  deepStrictEqual(sortedKeys(write.cells), sortedFlags());
  deepStrictEqual(sortedKeys(write.conditions), ["A", "AE", "B", "BE", "E", "G", "GE", "L", "LE", "NE"]);
  assertCompare(block, conditionValue(write, "E"), 16, "eq");
  assertCompare(block, conditionValue(write, "B"), 16, "lt_u");
  assertCompare(block, conditionValue(write, "L"), 16, "lt_s");
});

test("TEST helper writes logic cells, clears AF, and exposes only E/NE direct conditions", () => {
  const block = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 32);
    const right = s.get(s.operand(1), 32);

    s.writeFlags(buildTestFlags(s, { width: 32, left, right }));
  });
  const write = flagWrite(block);

  deepStrictEqual(exprCell(write, "AF"), { kind: "const", type: "i32", value: 0 });
  deepStrictEqual(exprCell(write, "CF"), { kind: "const", type: "i32", value: 0 });
  deepStrictEqual(exprCell(write, "OF"), { kind: "const", type: "i32", value: 0 });
  deepStrictEqual(sortedKeys(write.conditions), ["E", "NE"]);
  assertCompare(block, conditionValue(write, "E"), 32, "eq");
  assertCompare(block, conditionValue(write, "NE"), 32, "ne");
});

test("INC and DEC helpers preserve CF by omitting the CF cell and direct conditions", () => {
  for (const helper of [buildIncFlags, buildDecFlags]) {
    const block = buildHelperIr((s) => {
      const input = s.get(s.operand(0), 8);
      const result = helper === buildIncFlags ? s.i32Add(input, 1) : s.i32Sub(input, 1);

      s.writeFlags(helper(s, { width: 8, input, result }));
    });
    const write = flagWrite(block);

    strictEqual(Object.hasOwn(write.cells, "CF"), false);
    deepStrictEqual(sortedKeys(write.cells), ["AF", "PF", "SF", "OF", "ZF"].sort());
    strictEqual(write.conditions, undefined);

    const af = assertCompare(block, exprCell(write, "AF"), 32, "eq");
    const of = assertCompare(block, exprCell(write, "OF"), 8, "eq");

    deepStrictEqual(assertBinary(block, af.a, "and").b, const32(0xf));
    deepStrictEqual(af.b, helper === buildIncFlags ? const32(0xf) : const32(0));
    deepStrictEqual(of.b, helper === buildIncFlags ? const32(0x7f) : const32(0x80));
  }
});

test("NEG helper follows x86 CF and OF rules", () => {
  const block = buildHelperIr((s) => {
    const input = s.get(s.operand(0), 8);
    const result = s.i32Sub(0, input);

    s.writeFlags(buildNegFlags(s, { width: 8, input, result }));
  });
  const write = flagWrite(block);
  const cf = assertCompare(block, exprCell(write, "CF"), 8, "ne");
  const af = assertCompare(block, exprCell(write, "AF"), 32, "ne");
  const of = assertCompare(block, exprCell(write, "OF"), 8, "eq");

  deepStrictEqual(cf.b, const32(0));
  deepStrictEqual(assertBinary(block, af.a, "and").b, const32(0xf));
  deepStrictEqual(af.b, const32(0));
  deepStrictEqual(of.b, const32(0x80));
});

test("parity formulas use popcnt over only the low byte", () => {
  const block = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 32);
    const right = s.get(s.operand(1), 32);

    s.writeFlags(buildTestFlags(s, { width: 32, left, right }));
  });
  const pf = assertCompare(block, exprCell(flagWrite(block), "PF"), 32, "eq");
  const odd = assertBinary(block, pf.a, "and");
  const count = assertUnary(block, odd.a, "popcnt");
  const lowByte = assertBinary(block, count.value, "and");

  deepStrictEqual(pf.b, const32(0));
  deepStrictEqual(odd.b, const32(1));
  deepStrictEqual(lowByte.b, const32(0xff));
});

test("sign and overflow formulas consume the operation sign bit", () => {
  for (const width of [8, 16, 32] as const) {
    const block = buildHelperIr((s) => {
      const left = s.get(s.operand(0), width);
      const right = s.get(s.operand(1), width);

      s.writeFlags(buildAddResultAndFlags(s, { width, left, right }).flags);
    });
    const write = flagWrite(block);

    deepStrictEqual(assertBinary(block, exprCell(write, "SF"), "shr_u").b, const32(width - 1));
    deepStrictEqual(assertBinary(block, exprCell(write, "OF"), "shr_u").b, const32(width - 1));
  }
});

test("ADD and SUB helpers share binary flag DAG intermediates", () => {
  let addLeft: ValueRef | undefined;
  let addRight: ValueRef | undefined;
  let addResult: ValueRef | undefined;
  const addBlock = buildHelperIr((s) => {
    addLeft = s.get(s.operand(0), 16);
    addRight = s.get(s.operand(1), 16);

    const built = buildAddResultAndFlags(s, { width: 16, left: addLeft, right: addRight });

    addResult = built.result;
    s.writeFlags(built.flags);
  });
  const addDag = assertBinaryFlagDag(addBlock, 16, addLeft, addRight, addResult);
  const addWrite = flagWrite(addBlock);
  const addAfAnd = assertBinary(addBlock, exprCell(addWrite, "AF"), "and");
  const addAfShift = assertBinary(addBlock, addAfAnd.a, "shr_u");
  const addOfAnd = assertBinary(addBlock, assertBinary(addBlock, exprCell(addWrite, "OF"), "shr_u").a, "and");

  deepStrictEqual(addAfShift.a, addDag.aXorBXorResult);
  deepStrictEqual(addOfAnd.a, addDag.aXorResult);
  deepStrictEqual(addOfAnd.b, addDag.bXorResult);

  let subLeft: ValueRef | undefined;
  let subRight: ValueRef | undefined;
  let subResult: ValueRef | undefined;
  const subBlock = buildHelperIr((s) => {
    subLeft = s.get(s.operand(0), 16);
    subRight = s.get(s.operand(1), 16);

    const built = buildSubResultAndFlags(s, { width: 16, left: subLeft, right: subRight });

    subResult = built.result;
    s.writeFlags(built.flags);
  });
  const subDag = assertBinaryFlagDag(subBlock, 16, subLeft, subRight, subResult);
  const subWrite = flagWrite(subBlock);
  const subAfAnd = assertBinary(subBlock, exprCell(subWrite, "AF"), "and");
  const subAfShift = assertBinary(subBlock, subAfAnd.a, "shr_u");
  const subOfAnd = assertBinary(subBlock, assertBinary(subBlock, exprCell(subWrite, "OF"), "shr_u").a, "and");

  deepStrictEqual(subAfShift.a, subDag.aXorBXorResult);
  deepStrictEqual(subOfAnd.a, subDag.aXorB);
  deepStrictEqual(subOfAnd.b, subDag.aXorResult);
});

test("carryIn and borrowIn helpers use ADC/SBB-style carry paths", () => {
  let addCarryIn: ValueRef | undefined;
  const addBlock = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 8);
    const right = s.get(s.operand(1), 8);

    addCarryIn = s.compare(8, "ne", left, 0);
    s.writeFlags(buildAddResultAndFlags(s, { width: 8, left, right, carryIn: addCarryIn }).flags);
  });
  const addCf = assertSelect(addBlock, exprCell(flagWrite(addBlock), "CF"));
  const addWhenTrue = assertCompare(addBlock, addCf.whenTrue, 8, "le_u");
  const addWhenFalse = assertCompare(addBlock, addCf.whenFalse, 8, "lt_u");

  deepStrictEqual(addCf.condition, addCarryIn);
  deepStrictEqual(addWhenTrue.a, addWhenFalse.a);
  deepStrictEqual(addWhenTrue.b, addWhenFalse.b);

  let subBorrowIn: ValueRef | undefined;
  const subBlock = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 8);
    const right = s.get(s.operand(1), 8);

    subBorrowIn = s.compare(8, "ne", right, 0);
    s.writeFlags(buildSubResultAndFlags(s, { width: 8, left, right, borrowIn: subBorrowIn }).flags);
  });
  const subCf = assertSelect(subBlock, exprCell(flagWrite(subBlock), "CF"));
  const subWhenTrue = assertCompare(subBlock, subCf.whenTrue, 8, "le_u");
  const subWhenFalse = assertCompare(subBlock, subCf.whenFalse, 8, "lt_u");

  deepStrictEqual(subCf.condition, subBorrowIn);
  deepStrictEqual(subWhenTrue.a, subWhenFalse.a);
  deepStrictEqual(subWhenTrue.b, subWhenFalse.b);
});

test("result helpers share destination writeback result with flag cells", () => {
  let result: ValueRef | undefined;
  const block = buildHelperIr((s) => {
    const left = s.get(s.operand(0), 16);
    const right = s.get(s.operand(1), 16);
    const built = buildAddResultAndFlags(s, { width: 16, left, right });

    result = built.result;
    s.set(s.operand(0), built.result, 16);
    s.writeFlags(built.flags);
  });
  const set = block.find((op) => op.op === "set");
  const write = flagWrite(block);
  const zf = assertCompare(block, exprCell(write, "ZF"), 16, "eq");
  const sf = assertBinary(block, exprCell(write, "SF"), "shr_u");
  const cf = assertCompare(block, exprCell(write, "CF"), 16, "lt_u");

  if (set?.op !== "set" || result === undefined) {
    throw new Error("expected set op and helper result");
  }

  deepStrictEqual(set.value, result);
  deepStrictEqual(zf.a, result);
  deepStrictEqual(sf.a, result);
  deepStrictEqual(cf.a, result);
});

test("logic result helpers produce sparse semantic writes without direct conditions", () => {
  for (const op of ["and", "or", "xor"] as const) {
    const block = buildHelperIr((s) => {
      const left = s.get(s.operand(0), 8);
      const right = s.get(s.operand(1), 8);
      const built = buildLogicResultAndFlags(s, { width: 8, op, left, right });

      s.set(s.operand(0), built.result, 8);
      s.writeFlags(built.flags);
    });
    const write = flagWrite(block);

    deepStrictEqual(sortedKeys(write.cells), sortedFlags());
    strictEqual(write.conditions, undefined);
    deepStrictEqual(exprCell(write, "AF"), { kind: "const", type: "i32", value: 0 });
  }
});

function buildHelperIr(template: Parameters<typeof buildIr>[0]): IrBlock {
  const block = buildIr(template);

  validateIrBlock(block, { operandCount: 2 });
  assertNoValueTestBit(block);
  return block;
}

function flagWrite(block: IrBlock): IrFlagWriteOp {
  const op = block.find((entry) => entry.op === "flags.write");

  if (op?.op !== "flags.write") {
    throw new Error("expected flags.write op");
  }

  return op;
}

function exprCell(write: IrFlagWriteOp, flag: X86Flag): ValueRef {
  const cell = write.cells[flag];

  if (cell?.kind !== "expr") {
    throw new Error(`expected ${flag} expr cell`);
  }

  return cell.value;
}

function conditionValue(write: IrFlagWriteOp, cc: keyof NonNullable<IrFlagWriteOp["conditions"]>): ValueRef {
  const value = write.conditions?.[cc];

  if (value === undefined) {
    throw new Error(`expected ${cc} condition`);
  }

  return value;
}

function assertCompare(
  block: IrBlock,
  value: ValueRef,
  width: OperandWidth,
  operator: IrCompareOperator
): Extract<IrOp, { op: "value.compare" }> {
  const op = definition(block, value);

  if (op.op !== "value.compare") {
    throw new Error(`expected value.compare, got ${op.op}`);
  }

  strictEqual(op.width, width);
  strictEqual(op.operator, operator);
  return op;
}

function assertBinary(
  block: IrBlock,
  value: ValueRef,
  operator: IrBinaryOperator
): Extract<IrOp, { op: "value.binary" }> {
  const op = definition(block, value);

  if (op.op !== "value.binary") {
    throw new Error(`expected value.binary, got ${op.op}`);
  }

  strictEqual(op.operator, operator);
  return op;
}

function assertUnary(
  block: IrBlock,
  value: ValueRef,
  operator: IrUnaryOperator
): Extract<IrOp, { op: "value.unary" }> {
  const op = definition(block, value);

  if (op.op !== "value.unary") {
    throw new Error(`expected value.unary, got ${op.op}`);
  }

  strictEqual(op.operator, operator);
  return op;
}

function assertSelect(block: IrBlock, value: ValueRef): Extract<IrOp, { op: "value.select" }> {
  const op = definition(block, value);

  if (op.op !== "value.select") {
    throw new Error(`expected value.select, got ${op.op}`);
  }

  return op;
}

function assertNoValueTestBit(block: IrBlock): void {
  strictEqual(block.some((op) => (op as { op: string }).op === "value.testBit"), false);
}

function assertBinaryFlagDag(
  block: IrBlock,
  width: OperandWidth,
  left: ValueRef | undefined,
  right: ValueRef | undefined,
  result: ValueRef | undefined
): Readonly<{
  a: ValueRef;
  b: ValueRef;
  result: ValueRef;
  aXorResult: ValueRef;
  bXorResult: ValueRef;
  aXorB: ValueRef;
  aXorBXorResult: ValueRef;
}> {
  if (left === undefined || right === undefined || result === undefined) {
    throw new Error("expected helper inputs and result");
  }

  const a = findProject(block, left, width).dst;
  const b = findProject(block, right, width).dst;
  const aXorResult = findBinary(block, "xor", a, result).dst;
  const bXorResult = findBinary(block, "xor", b, result).dst;
  const aXorB = findBinary(block, "xor", a, b).dst;
  const aXorBXorResult = findBinary(block, "xor", aXorB, result).dst;

  return { a, b, result, aXorResult, bXorResult, aXorB, aXorBXorResult };
}

function findProject(
  block: IrBlock,
  value: ValueRef,
  width: OperandWidth
): Extract<IrOp, { op: "value.project" }> {
  const op = block.find((entry): entry is Extract<IrOp, { op: "value.project" }> =>
    entry.op === "value.project" &&
    entry.width === width &&
    valueRefsEqual(entry.value, value)
  );

  if (op === undefined) {
    throw new Error("missing value.project");
  }

  return op;
}

function findBinary(
  block: IrBlock,
  operator: IrBinaryOperator,
  a: ValueRef,
  b: ValueRef
): Extract<IrOp, { op: "value.binary" }> {
  const op = block.find((entry): entry is Extract<IrOp, { op: "value.binary" }> =>
    entry.op === "value.binary" &&
    entry.operator === operator &&
    valueRefsEqual(entry.a, a) &&
    valueRefsEqual(entry.b, b)
  );

  if (op === undefined) {
    throw new Error(`missing ${operator} binary op`);
  }

  return op;
}

function const32(value: number): ValueRef {
  return { kind: "const", type: "i32", value };
}

function valueRefsEqual(a: ValueRef, b: ValueRef): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "var":
      return b.kind === "var" && a.id === b.id;
    case "const":
      return b.kind === "const" && a.type === b.type && a.value === b.value;
    case "nextEip":
      return b.kind === "nextEip";
  }
}

function definition(block: IrBlock, value: ValueRef): IrOp {
  if (value.kind !== "var") {
    throw new Error(`expected var value, got ${value.kind}`);
  }

  const op = block.find((entry) => irOpDst(entry)?.id === value.id);

  if (op === undefined) {
    throw new Error(`missing definition for var ${value.id}`);
  }

  return op;
}

function sortedKeys(record: object | undefined): string[] {
  return Object.keys(record ?? {}).sort();
}

function sortedFlags(): string[] {
  return [...x86Flags].sort();
}
