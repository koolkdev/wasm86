import {
  deepStrictEqual,
  strictEqual,
  test,
  ok,
  decodeBytes,
  buildBlock,
  irOpIsTerminator,
  buildJitCodegenEmissionPlan,
  planJitCodegen,
  startAddress,
  codegenIr,
  blockIr,
  constValue,
  irOpDstId,
  irOpOperandIndexes,
} from "./block-test-helpers.js";

import { throws } from "node:assert";

test("buildBlock rejects empty decoded instruction lists", () => {
  throws(() => buildBlock([]), /cannot build empty JIT IR block/);
});

test("buildBlock preserves decoded instruction metadata", () => {
  const decoded = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const block = buildBlock([decoded]);
  const instruction = block.instructions[0]!;

  strictEqual(block.instructions.length, 1);
  strictEqual(instruction.instructionId, decoded.spec.id);
  strictEqual(instruction.eip, decoded.address);
  strictEqual(instruction.nextEip, decoded.nextEip);
  strictEqual(instruction.nextMode, "exit");
  strictEqual(instruction.operands.length, decoded.operands.length);
});

test("buildBlock binds static operand facts", () => {
  const movImm = buildBlock([ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress))])
    .instructions[0]!;
  const movMem = buildBlock([ok(decodeBytes([0x8b, 0x03], startAddress))])
    .instructions[0]!;
  const jz = buildBlock([ok(decodeBytes([0x74, 0x05], startAddress))])
    .instructions[0]!;

  deepStrictEqual(movImm.operands.map((operand) => operand.kind), ["static.reg", "static.imm32"]);
  deepStrictEqual(movMem.operands.map((operand) => operand.kind), ["static.reg", "static.mem"]);
  deepStrictEqual(jz.operands.map((operand) => operand.kind), ["static.relTarget"]);
  strictEqual(jz.operands[0]?.kind === "static.relTarget" ? jz.operands[0].target : undefined, startAddress + 7);
});

test("buildBlock builds instruction-local IR bodies", () => {
  const first = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const second = ok(decodeBytes([0x83, 0xc0, 0x01], first.nextEip));
  const block = buildBlock([first, second]);
  const firstIr = block.instructions[0]!.ir;
  const secondIr = block.instructions[1]!.ir;
  const firstDefIds = firstIr.flatMap(irOpDstId);
  const secondDefIds = secondIr.flatMap(irOpDstId);

  strictEqual("ir" in block, false);
  strictEqual("operands" in block, false);
  strictEqual(block.instructions.length, 2);
  strictEqual(block.instructions[0]!.operands.length, first.operands.length);
  strictEqual(block.instructions[1]!.operands.length, second.operands.length);
  strictEqual(firstIr.filter((op) => op.op === "next").length, 1);
  strictEqual(secondIr.filter((op) => op.op === "next").length, 1);
  deepStrictEqual([...new Set(firstIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  deepStrictEqual([...new Set(secondIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  strictEqual(new Set(firstDefIds).size, firstDefIds.length);
  strictEqual(new Set(secondDefIds).size, secondDefIds.length);
  strictEqual(Math.min(...secondDefIds), 0);
});

test("JIT codegen plan keeps instruction-local operand namespaces", () => {
  const first = ok(decodeBytes([0x89, 0x18], startAddress));
  const second = ok(decodeBytes([0x89, 0x11], first.nextEip));
  const block = buildBlock([first, second]);
  const codegenPlan = planJitCodegen(block);
  const emissionPlan = buildJitCodegenEmissionPlan(codegenPlan);
  const firstIr = block.instructions[0]!.ir;
  const secondIr = block.instructions[1]!.ir;

  strictEqual("ir" in block, false);
  strictEqual("operands" in block, false);
  strictEqual(emissionPlan.instructions.length, 2);
  strictEqual(firstIr.filter(irOpIsTerminator).length, 1);
  strictEqual(secondIr.filter(irOpIsTerminator).length, 1);
  deepStrictEqual([...new Set(firstIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
  deepStrictEqual([...new Set(secondIr.flatMap(irOpOperandIndexes))].sort((a, b) => a - b), [0, 1]);
});

test("buildBlock lowers unary ALU forms with preserved widths", () => {
  const notIr = buildBlock([ok(decodeBytes([0x66, 0xf7, 0xd0], startAddress))])
    .instructions[0]!.ir;
  const negIr = buildBlock([ok(decodeBytes([0xf6, 0xd8], startAddress))])
    .instructions[0]!.ir;
  const notSet = notIr.find((op) => op.op === "set");
  const negFlags = negIr.find((op) => op.op === "flags.set");

  strictEqual(notIr.some((op) => op.op === "value.binary" && op.operator === "xor"), true);
  strictEqual(notIr.some((op) => op.op === "flags.set"), false);
  strictEqual(notSet?.op === "set" ? notSet.accessWidth : undefined, 16);

  strictEqual(negIr.some((op) => op.op === "value.binary" && op.operator === "sub"), true);
  strictEqual(negFlags?.op === "flags.set" ? negFlags.producer : undefined, "sub");
  strictEqual(negFlags?.op === "flags.set" ? negFlags.width : undefined, 8);
});

test("buildBlock keeps overwritten flag producers as value-state writes", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], cmp.nextEip));
  const ir = codegenIr(buildBlock([cmp, add]));
  const flagSets = ir.filter((op) => op.op === "flags.set");

  deepStrictEqual(flagSets.map((op) => op.op === "flags.set" ? op.producer : undefined), ["sub", "add"]);
});

test("buildBlock keeps branch conditions as JIT flag values", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jz = ok(decodeBytes([0x74, 0x05], add.nextEip));
  const branchBlock = buildBlock([add, jz]);
  const branchIr = blockIr(branchBlock);
  const conditionalJumpOpIndex = branchBlock.instructions[1]!.ir.findIndex((op) => op.op === "conditionalJump");

  strictEqual(conditionalJumpOpIndex !== -1, true);
  strictEqual(branchIr.some((op) => op.op === "flags.condition"), true);

  const trap = ok(decodeBytes([0xcd, 0x2e], add.nextEip));
  const exitBlock = buildBlock([add, trap]);
  const hostTrapOpIndex = exitBlock.instructions[1]!.ir.findIndex((op) => op.op === "hostTrap");

  strictEqual(hostTrapOpIndex !== -1, true);
});

test("buildBlock keeps earlier CF producer live across INC", () => {
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const inc = ok(decodeBytes([0x40], add.nextEip));
  const jc = ok(decodeBytes([0x72, 0x05], inc.nextEip));
  const ir = codegenIr(buildBlock([add, inc, jc]));
  const flagSets = ir.filter((op) => op.op === "flags.set");

  deepStrictEqual(flagSets.map((op) => op.op === "flags.set" ? op.producer : undefined), ["add", "inc"]);
});

test("buildBlock keeps cmp and jcc branch conditions in flag value state", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const je = ok(decodeBytes([0x74, 0x05], cmp.nextEip));
  const ir = codegenIr(buildBlock([cmp, je]));

  strictEqual(ir.some((op) => op.op === "flags.condition"), true);
});

test("buildBlock lowers cmovcc through a select value and normal write", () => {
  const instruction = ok(decodeBytes([0x0f, 0x44, 0xd1], startAddress));
  const ir = buildBlock([instruction]).instructions[0]!.ir;

  deepStrictEqual(ir, [
    { op: "get", dst: { kind: "var", id: 0 }, source: { kind: "operand", index: 1 }, accessWidth: 32 },
    { op: "flags.condition", dst: { kind: "var", id: 1 }, cc: "E" },
    { op: "get", dst: { kind: "var", id: 2 }, source: { kind: "operand", index: 0 }, accessWidth: 32 },
    {
      op: "value.select",
      type: "i32",
      dst: { kind: "var", id: 3 },
      condition: { kind: "var", id: 1 },
      whenTrue: { kind: "var", id: 0 },
      whenFalse: { kind: "var", id: 2 }
    },
    { op: "set", target: { kind: "operand", index: 0 }, value: { kind: "var", id: 3 }, accessWidth: 32 },
    { op: "next" }
  ]);
});

test("buildBlock lowers setcc through a byte select value and normal write", () => {
  const instruction = ok(decodeBytes([0x0f, 0x94, 0xc0], startAddress));
  const ir = buildBlock([instruction]).instructions[0]!.ir;
  const selectIndex = ir.findIndex((op) => op.op === "value.select");
  const setIndex = ir.findIndex((op) => op.op === "set");

  strictEqual(selectIndex !== -1 && setIndex === selectIndex + 1, true);
  strictEqual(ir[selectIndex]?.op === "value.select" ? constValue(ir[selectIndex].whenTrue) : undefined, 1);
  strictEqual(ir[selectIndex]?.op === "value.select" ? constValue(ir[selectIndex].whenFalse) : undefined, 0);
  strictEqual(ir[setIndex]?.op === "set" ? ir[setIndex].accessWidth : undefined, 8);
});

test("buildBlock lowers setcc conditions from current flag values", () => {
  const cmp = ok(decodeBytes([0x39, 0xd8], startAddress));
  const sete = ok(decodeBytes([0x0f, 0x94, 0xc0], cmp.nextEip));
  const ir = codegenIr(buildBlock([cmp, sete]));

  strictEqual(ir.some((op) => op.op === "flags.condition"), true);
});
