import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  createIrBlockBuilder,
  externalInstructionLocation,
  staticInstructionLocation as loc
} from "#ir/builder.js";
import {
  immBinding,
  immExternalBinding,
  memBinding,
  memDynamicBinding,
  memStaticBinding,
  regBinding,
  regDynamicBinding
} from "#ir/operands.js";
import {
  eipChannel,
  gprChannel,
  instructionCountChannel,
  lazyFlagsKindChannel
} from "#ir/slots.js";
import type {
  Action,
  BranchAction,
  EdgeFlushAction,
  GuardMemoryAction,
  ReadMemoryAction,
  ReadStateAction,
  WriteMemoryAction,
  WriteStateAction
} from "#ir/actions.js";
import type { EdgeRegion, IrBlock } from "#ir/block.js";
import type { ValueId, ValueNode } from "#ir/values.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import { x86EflagsBitOffset, x86Flags, x86StatusFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { jccSemantic, jmpSemantic } from "#x86/semantics/control.js";
import { leaSemantic } from "#x86/semantics/lea.js";
import { intSemantic } from "#x86/semantics/misc.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#x86/semantics/mov.js";
import { setccSemantic } from "#x86/semantics/setcc.js";
import { popfdSemantic, popSemantic, pushfdSemantic } from "#x86/semantics/stack.js";
import { testSemantic as testInstructionSemantic } from "#x86/semantics/test.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";
import { assertLazyRecord } from "./lazy-flags.js";

// Every instruction advances the count channel; the dedicated tests at the
// end cover that bookkeeping, the shape tests assert around it.
function isInstructionCountAction(action: Action | EdgeFlushAction): boolean {
  switch (action.kind) {
    case "readState":
    case "writeState":
      return action.slot.kind === "instructionCount";
    default:
      return false;
  }
}

function entryActions(block: IrBlock): readonly Action[] {
  return rawEntryActions(block).filter((action) => !isInstructionCountAction(action));
}

function rawEntryActions(block: IrBlock): readonly Action[] {
  const entry = block.regions[0]!;

  ok(entry.kind === "entry", "first region is the entry");
  return entry.actions;
}

function edgeRegion(block: IrBlock, index: number): EdgeRegion {
  const region = block.regions[index]!;

  ok(region.kind === "edge", `region ${index} is an edge`);
  return region;
}

function edgeFlushes(block: IrBlock, index: number): EdgeFlushAction[] {
  return edgeRegion(block, index).flushes.filter((flush) => !isInstructionCountAction(flush));
}

function edgeWriteFlushes(block: IrBlock, index: number): WriteStateAction[] {
  return edgeFlushes(block, index).filter(
    (flush): flush is WriteStateAction => flush.kind === "writeState"
  );
}

function stateWrites(block: IrBlock): WriteStateAction[] {
  return entryActions(block).filter(
    (action): action is WriteStateAction => action.kind === "writeState"
  );
}

function branchAction(block: IrBlock): BranchAction {
  const action = entryActions(block).find((entry): entry is BranchAction => entry.kind === "branch");

  ok(action !== undefined, "expected branch action");
  return action;
}

function nodeKinds(block: IrBlock): ValueNode["kind"][] {
  const kinds: ValueNode["kind"][] = [];

  for (let id = 0; id < block.values.size(); id += 1) {
    kinds.push(block.values.node(id).kind);
  }

  return kinds;
}

function writtenFlags(block: IrBlock): X86Flag[] {
  return flagWriteEntries(block).map((write) => write.flag);
}

function flagWriteEntries(block: IrBlock): ReadonlyArray<Readonly<{ flag: X86Flag; value: ValueId }>> {
  return stateWrites(block).flatMap((write) =>
    write.slot.kind === "flag" ? [{ flag: write.slot.flag, value: write.value }] : []
  );
}

function flagWriteValue(block: IrBlock, flag: X86StatusFlag): ValueId {
  const writes = flagWriteEntries(block).filter((write) => write.flag === flag);

  strictEqual(writes.length, 1, `expected exactly one ${flag} write`);
  return writes[0]!.value;
}

function assertNegatedHelperFlag(values: IrBlock["values"], id: ValueId, flag: X86StatusFlag): void {
  const node = values.node(id);

  ok(node.kind === "compare", `expected ${flag} helper to be compared against zero`);
  strictEqual(node.operator, "eq");
  assertHelperFlag(values, node.a, flag);
  strictEqual(node.b, values.const(0));
}

function assertHelperFlag(values: IrBlock["values"], id: ValueId, flag: X86StatusFlag): void {
  deepStrictEqual(values.node(id), { kind: "helperCall", helper: { kind: "lazyFlag", flag } });
}

test("mov r32, imm32 flushes the register write and dispatches at the next eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x401000, 0x401005));

  const block = builder.finish();
  const v = block.values;

  strictEqual(block.regions.length, 1);

  const entry = block.regions[0]!;

  strictEqual(entry.id, block.entry);
  strictEqual(entry.kind, "entry");
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x12345678) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x401005) },
    { kind: "dispatch", targetEip: v.const(0x401005) }
  ]);
  deepStrictEqual(v.node(v.const(0x12345678)), { kind: "const", value: 0x12345678 });
  // The instruction-start eip, immediate, next eip, and count advance.
  strictEqual(v.size(), 6);
});

test("pending writes overwrite per channel and consts deduplicate across instructions", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(7)], loc(0x1005, 0x100a));
  builder.addInstruction(mov, [regBinding("eax"), immBinding(9)], loc(0x100a, 0x100f));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: block.values.const(9) },
    { kind: "writeState", slot: gprChannel("ecx"), value: block.values.const(7) },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x100f) },
    { kind: "dispatch", targetEip: block.values.const(0x100f) }
  ]);

  // 7, 9, the four eip constants, and the count read with its three folded
  // advances — both movs of 7 share one const.
  strictEqual(block.values.size(), 13);
});

test("mov r32, r32 records one readState and forwards its leaf", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);
  deepStrictEqual(v.node(1), { kind: "actionOutput" });
  // The instruction-start eip, read leaf, next eip, and count advance.
  strictEqual(v.size(), 6);
});

test("repeated get of an unwritten channel returns the same leaf across instructions", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], loc(0x1000, 0x1002));
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 1 },
    { kind: "writeState", slot: gprChannel("ecx"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1004) },
    { kind: "dispatch", targetEip: block.values.const(0x1004) }
  ]);
});

test("add eax, imm32 commits a lazy add record and writes the register", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const writes = stateWrites(block);

  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(writes.find((write) => write.slot === gprChannel("eax"))?.value, sum);
});

test("two adds in one block flush one lazy add record, second instruction wins", () => {
  const builder = createIrBlockBuilder();
  const add = aluSemantic("add", 32);

  builder.addInstruction(add, [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(add, [regBinding("eax"), immBinding(7)], loc(0x1003, 0x1006));

  const block = builder.finish();
  const actions = entryActions(block);
  const writes = stateWrites(block);
  const v = block.values;

  // One read feeds both adds; the final add source is the only lazy flag image
  // flushed, plus eax and eip.
  strictEqual(actions.filter((action) => action.kind === "readState").length, 1);
  strictEqual(writes.length, 5);
  strictEqual(new Set(writes.map((write) => write.slot)).size, 5);
  strictEqual(writes.filter((write) => write.slot.kind === "flag").length, 0);

  const eax = actions.find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;
  const sum1 = v.binary("add", eax, v.const(5));
  const sum2 = v.binary("add", sum1, v.const(7));

  strictEqual(writes.find((write) => write.slot === gprChannel("eax"))?.value, sum2);
  assertLazyRecord(writes, v, { kind: "ADD", width: 32, left: sum1, right: v.const(7) });
});

test("inc flushes a full explicit image with CF preserved through a helper call", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(unaryAluSemantic("inc", 32), [regBinding("eax")], loc(0x1000, 0x1001));

  const block = builder.finish();

  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  assertHelperFlag(block.values, flagWriteValue(block, "CF"), "CF");
  strictEqual(stateWrites(block).find((write) => write.slot === lazyFlagsKindChannel)?.value, block.values.const(0));
});

test("cmp commits a lazy sub record but no register or explicit flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const writes = stateWrites(block);
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );

  assertLazyRecord(writes, block.values, { kind: "SUB", width: 32, left: reads[0]!.output, right: reads[1]!.output });
  strictEqual(writes.some((write) => write.slot.kind === "gpr"), false);
  strictEqual(writes.filter((write) => write.slot === eipChannel).length, 1);
  deepStrictEqual(entryActions(block).at(-1), { kind: "dispatch", targetEip: block.values.const(0x1002) });
});

// A template writing only ZF; omitted status flags are preserved by resolving
// their live input backing into the full explicit image.
const directZfTemplate: SemanticTemplate = (s) => {
  s.writeFlag("ZF", s.const32(1));
};

test("writeFlag flushes a full explicit image with omitted flags preserved through helper calls", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(directZfTemplate, [], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), [...x86StatusFlags].sort());
  strictEqual(flagWriteValue(block, "ZF"), block.values.const(1));

  for (const flag of x86StatusFlags.filter((flag) => flag !== "ZF")) {
    assertHelperFlag(block.values, flagWriteValue(block, flag), flag);
  }
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );

  strictEqual(stateWrites(block).find((write) => write.slot === lazyFlagsKindChannel)?.value, block.values.const(0));
});

test("an omitted direct flag write preserves the previous instruction's pending flag", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(directZfTemplate, [], loc(0x1003, 0x1005));

  const block = builder.finish();

  // The second instruction does not touch AF, so the add's AF expression
  // survives and flushes.
  const v = block.values;
  const a = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;
  const b = v.const(5);
  const result = v.binary("add", a, b);
  const carryChain = v.binary("xor", v.binary("xor", a, b), result);
  const af = v.binary("and", v.binary("shr_u", carryChain, v.const(4)), v.const(1));

  strictEqual(flagWriteValue(block, "AF"), af);

  // The second instruction's constant ZF write wins over the add's expression.
  strictEqual(flagWriteValue(block, "ZF"), v.const(1));
});

test("xchg eax, ebx swaps pendings through two reads with no temporaries", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("eax") },
    { kind: "readState", output: 2, slot: gprChannel("ebx") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 1 },
    { kind: "writeState", slot: gprChannel("eax"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1002) },
    { kind: "dispatch", targetEip: block.values.const(0x1002) }
  ]);

  // The instruction-start eip, two read leaves, next eip, and count advance — no
  // temporaries were created.
  strictEqual(block.values.size(), 7);
});

test("mov r8, r8 reads and writes byte channels with no bit algebra", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1000, 0x1002));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("ah") },
    { kind: "writeState", slot: gprChannel("bl"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1002) },
    { kind: "dispatch", targetEip: block.values.const(0x1002) }
  ]);
  // The instruction-start eip, read leaf, next eip, and count advance — no
  // masks or shifts were created.
  strictEqual(block.values.size(), 6);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("al"), value: v.const(0x12) },
    { kind: "readState", output: 6, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 6 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1004) },
    { kind: "dispatch", targetEip: v.const(0x1004) }
  ]);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("al")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x12345678) },
    { kind: "readState", output: 6, slot: gprChannel("al") },
    { kind: "writeState", slot: gprChannel("bl"), value: 6 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1007) },
    { kind: "dispatch", targetEip: v.const(0x1007) }
  ]);
});

test("write al then write eax drops the byte pending with no flush", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1002, 0x1007));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x12345678) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1007) },
    { kind: "dispatch", targetEip: v.const(0x1007) }
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], loc(0x1005, 0x1007));

  const block = builder.finish();
  const actions = entryActions(block);

  strictEqual(actions[0]!.kind, "writeState");
  deepStrictEqual(actions[1], { kind: "readState", output: 6, slot: gprChannel("ah") });
});

test("ax and al pendings mix without touching flag pendings", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.addInstruction(movSemantic(8), [regBinding("ah"), immBinding(0x12)], loc(0x1002, 0x1004));
  builder.addInstruction(movSemantic(16), [regBinding("cx"), regBinding("ax")], loc(0x1004, 0x1007));

  const block = builder.finish();
  const actions = entryActions(block);
  const indexOf = (predicate: (action: (typeof actions)[number]) => boolean) =>
    actions.findIndex(predicate);

  // al and ah are disjoint, so both stay pending until the ax read flushes
  // them; the lazy flag record rides through it all and flushes once at the end.
  const alFlush = indexOf((a) => a.kind === "writeState" && a.slot === gprChannel("al"));
  const ahFlush = indexOf((a) => a.kind === "writeState" && a.slot === gprChannel("ah"));
  const axRead = indexOf((a) => a.kind === "readState" && a.slot === gprChannel("ax"));
  const lazyKindFlush = indexOf((a) => a.kind === "writeState" && a.slot === lazyFlagsKindChannel);

  ok(alFlush !== -1 && ahFlush !== -1 && axRead !== -1, "expected al/ah flushes and an ax read");
  ok(alFlush < axRead && ahFlush < axRead, "the ax read must flush al and ah first");
  ok(axRead < lazyKindFlush, "lazy flag flush stays at the end of the block");
  deepStrictEqual([...writtenFlags(block)], []);

  // The flushed al carries the add's projected result.
  const v = block.values;
  const reads = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const sum = v.project(8, v.binary("add", reads[0]!.output, reads[1]!.output));

  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value, sum);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 8, left: reads[0]!.output, right: reads[1]!.output });
});

test("movzx r32, r8 forwards the unsigned byte read unmasked", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("al") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1003) },
    { kind: "dispatch", targetEip: block.values.const(0x1003) }
  ]);
  strictEqual(block.values.size(), 6);
});

test("movsx r32, r8 marks the read for a sign-extending load", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 1, slot: gprChannel("al"), signed: true },
    { kind: "writeState", slot: gprChannel("ebx"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1003) },
    { kind: "dispatch", targetEip: block.values.const(0x1003) }
  ]);
  strictEqual(block.values.size(), 6);
});

test("narrow signed compares sign-extend both operands", () => {
  const cmp8: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.compare(8, "lt_s", s.get(s.operand(0), 32), s.get(s.operand(1), 32)), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmp8, [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const compare = v.compare(
    "lt_s",
    v.unary("extend8_s", reads[0]!.output),
    v.unary("extend8_s", reads[1]!.output)
  );

  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, compare);
});

test("an 8-bit unsigned compare of covered operands creates no projections", () => {
  const cmpAl: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.compare(8, "lt_u", s.get(s.operand(0), 8), s.get(s.operand(1), 8)), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpAl, [regBinding("al"), immBinding(5)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  // The al read fits unsigned 8 and the constant fits by value, so the
  // compare uses the raw operands.
  const al = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("al")
  )!.output;

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.compare("lt_u", al, v.const(5))
  );
  ok(!nodeKinds(block).includes("project"), "no projections expected");
});

test("an 8-bit equality on an unproven value keeps its mask", () => {
  const cmpSum: SemanticTemplate = (s) => {
    const sum = s.i32Add(s.get(s.operand(0), 8), s.get(s.operand(1), 8));

    s.set(s.operand(0), s.compare(8, "eq", sum, s.const32(0)), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSum, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const sum = v.binary("add", reads[0]!.output, reads[1]!.output);

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.compare("eq", v.project(8, sum), v.const(0))
  );
});

test("a signed byte get feeds a signed compare with no extra extends", () => {
  const cmpSigned: SemanticTemplate = (s) => {
    const a = s.get(s.operand(0), 8, { signed: true });
    const b = s.get(s.operand(1), 8, { signed: true });

    s.set(s.operand(0), s.compare(8, "lt_s", a, b), 8);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSigned, [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const actions = entryActions(block);
  const reads = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );

  deepStrictEqual(actions[0], { kind: "readState", output: reads[0]!.output, slot: gprChannel("al"), signed: true });
  deepStrictEqual(actions[1], { kind: "readState", output: reads[1]!.output, slot: gprChannel("bl"), signed: true });
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    block.values.compare("lt_s", reads[0]!.output, reads[1]!.output)
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("value methods build through the builder", () => {
  const abs: SemanticTemplate = (s) => {
    const value = s.get(s.operand(0), 32);
    const zero = s.const32(0);
    const negative = s.compare(32, "lt_s", value, zero);

    s.set(s.operand(0), s.i32Select(negative, s.i32Sub(zero, value), value), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(abs, [regBinding("eax")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!;
  const zero = block.values.const(0);
  const compare = block.values.compare("lt_s", read.output, zero);
  const negated = block.values.binary("sub", zero, read.output);
  const selected = block.values.select(compare, negated, read.output);

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: read.output, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: selected },
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x1003) },
    { kind: "dispatch", targetEip: block.values.const(0x1003) }
  ]);
  deepStrictEqual(block.values.node(compare), { kind: "compare", operator: "lt_s", a: read.output, b: zero });
  deepStrictEqual(block.values.node(negated), { kind: "binary", operator: "sub", a: zero, b: read.output });
  deepStrictEqual(block.values.node(selected), { kind: "select", condition: compare, whenTrue: negated, whenFalse: read.output });
});

test("jmp dispatches at the target", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  const block = builder.finish();

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: eipChannel, value: block.values.const(0x2000) },
    { kind: "dispatch", targetEip: block.values.const(0x2000) }
  ]);
});

test("a jump flushes earlier pendings and dispatches at the target eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x77) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x2000) },
    { kind: "dispatch", targetEip: v.const(0x2000) }
  ]);
});

test("a block ended by a jump rejects further instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], loc(0x1000, 0x1005));

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1005, 0x100a)),
    /after a block terminator/
  );
});

test("ops after a control terminator in one template fail loudly", () => {
  const jumpThenSet: SemanticTemplate = (s) => {
    const target = s.const32(0x2000);
    const value = s.const32(1);

    s.jump(target);
    s.set(s.reg("eax"), value, 32);
  };

  throws(
    () => createIrBlockBuilder().addInstruction(jumpThenSet, [], loc(0x1000, 0x1005)),
    /cannot emit set after instruction terminator/
  );
});

test("jcc after cmp source uses the source-derived condition with per-edge lazy commits", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const eax = actions.find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;

  strictEqual(block.regions.length, 3);
  deepStrictEqual(actions[actions.length - 1], {
    kind: "branch",
    condition: v.compare("eq", eax, v.const(5)),
    taken: 1,
    notTaken: 2
  });

  // The branch is the entry's terminator: nothing flushes on the main path.
  strictEqual(stateWrites(block).length, 0);

  // Each edge flushes the cmp's lazy record and dispatches at its own eip.
  const taken = edgeFlushes(block, 1);
  const notTaken = edgeFlushes(block, 2);

  for (const flushes of [taken, notTaken]) {
    strictEqual(flushes.length, 4);
    assertLazyRecord(flushes, v, { kind: "SUB", width: 32, left: eax, right: v.const(5) });
  }

  strictEqual(edgeWriteFlushes(block, 1).find((write) => write.slot === eipChannel)?.value, v.const(0x2000));
  deepStrictEqual(edgeRegion(block, 1).terminator, { kind: "dispatch", targetEip: v.const(0x2000) });
  strictEqual(edgeWriteFlushes(block, 2).find((write) => write.slot === eipChannel)?.value, v.const(0x1005));
  deepStrictEqual(edgeRegion(block, 2).terminator, { kind: "dispatch", targetEip: v.const(0x1005) });
});

test("jcc after test source uses the source-derived condition with no flag byte reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(testInstructionSemantic(32), [regBinding("eax"), regBinding("ebx")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const result = v.binary("and", reads[0]!.output, reads[1]!.output);

  strictEqual(branchAction(block).condition, v.compare("eq", result, v.const(0)));
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
  strictEqual(stateWrites(block).length, 0);

  for (const flushes of [edgeWriteFlushes(block, 1), edgeWriteFlushes(block, 2)]) {
    assertLazyRecord(flushes.filter((flush) => flush.slot.kind === "lazyFlags"), v, {
      kind: "LOGIC_RESULT",
      width: 32,
      result
    });
  }
});

const subSourceThenJccTemplate: SemanticTemplate = (s) => {
  const left = s.get(s.reg("eax"), 32);
  const right = s.get(s.reg("ebx"), 32);
  const result = s.i32Sub(left, right);

  s.writeStatusFlagsSource({ kind: "sub", width: 32, left, right, result });
  s.conditionalJump(s.condition("E"), s.const32(0x2000), s.const32(0x1005));
};

test("jcc after a sub flag source uses the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(subSourceThenJccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );

  strictEqual(branchAction(block).condition, block.values.compare("eq", reads[0]!.output, reads[1]!.output));
});

test("jcc after 16-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(16), [regBinding("ax"), regBinding("bx")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("L"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const condition = v.compare(
    "lt_s",
    v.unary("extend16_s", reads[0]!.output),
    v.unary("extend16_s", reads[1]!.output)
  );

  strictEqual(branchAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
});

test("jcc after 8-bit cmp source sign-extends operands for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(8), [regBinding("al"), regBinding("bl")], loc(0x1000, 0x1002));
  builder.addInstruction(jccSemantic("GE"), [immBinding(0x2000)], loc(0x1002, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const condition = v.compare(
    "ge_s",
    v.unary("extend8_s", reads[0]!.output),
    v.unary("extend8_s", reads[1]!.output)
  );

  strictEqual(branchAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
});

test("jcc after 16-bit cmp immediate source sign-extends immediates for signed direct conditions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(16), [regBinding("ax"), immBinding(0x8000)], loc(0x1000, 0x1004));
  builder.addInstruction(jccSemantic("LE"), [immBinding(0x2000)], loc(0x1004, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const ax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ax")
  )!.output;
  const condition = v.compare(
    "le_s",
    v.unary("extend16_s", ax),
    v.const(-0x8000)
  );

  strictEqual(branchAction(block).condition, condition);
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
});

test("int flushes pending state with the resume eip before a host trap exit", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(intSemantic(), [immBinding(0x21)], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x77) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1007) },
    { kind: "exit", reason: "hostTrap", payload: v.const(0x21) }
  ]);
});

test("a block ended by a host trap rejects further instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(intSemantic(), [immBinding(3)], loc(0x1000, 0x1002));

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1002, 0x1007)),
    /after a block terminator/
  );
});

test("setcc after cmp source consumes the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(setccSemantic("B"), [regBinding("al")], loc(0x1003, 0x1006));

  const block = builder.finish();
  const v = block.values;
  // B is derived directly from the cmp source; no flag byte is read.
  const ebx = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;
  const condition = v.compare("lt_u", ebx, v.const(5));

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(entryActions(block).filter((action) => action.kind === "readState").length, 1);
});

const logicSourceThenSetccTemplate: SemanticTemplate = (s) => {
  const left = s.get(s.reg("eax"), 32);
  const right = s.get(s.reg("ebx"), 32);
  const result = s.i32And(left, right);

  s.writeStatusFlagsSource({ kind: "logic", width: 32, result });
  s.set(s.reg("al"), s.i32Select(s.condition("NE"), s.const32(1), s.const32(0)), 8);
};

test("setcc after a logic flag source uses the source-derived condition", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(logicSourceThenSetccTemplate, [], loc(0x1000, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const result = v.binary("and", reads[0]!.output, reads[1]!.output);
  const condition = v.compare("ne", result, v.const(0));

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.select(condition, v.const(1), v.const(0))
  );
  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );
});

test("setcc with no pending flag value builds from helper calls", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(setccSemantic("A"), [regBinding("al")], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;

  strictEqual(
    entryActions(block).some((action) => action.kind === "readState" && action.slot.kind === "flag"),
    false
  );

  const zero = v.const(0);
  const write = stateWrites(block).find((write) => write.slot === gprChannel("al"));

  ok(write !== undefined, "expected setcc to write al");
  const select = v.node(write.value);

  ok(select.kind === "select", "expected setcc to write a select value");
  strictEqual(select.whenTrue, v.const(1));
  strictEqual(select.whenFalse, zero);

  const condition = v.node(select.condition);

  ok(condition.kind === "binary", "expected A condition to lower to !CF && !ZF");
  strictEqual(condition.operator, "and");
  assertNegatedHelperFlag(v, condition.a, "CF");
  assertNegatedHelperFlag(v, condition.b, "ZF");
});

test("setcc after an intervening add uses the latest source-expanded flag expression", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(aluSemantic("add", 32), [regBinding("ecx"), immBinding(1)], loc(0x1003, 0x1006));
  builder.addInstruction(setccSemantic("E"), [regBinding("al")], loc(0x1006, 0x1009));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // E rebuilds from the add's source-expanded ZF expression; no flag byte load.
  strictEqual(
    actions.filter((action) => action.kind === "readState" && action.slot.kind === "flag").length,
    0
  );

  const ecxRead = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState"
  )[1]!.output;
  const sum = v.binary("add", ecxRead, v.const(1));
  const zf = v.compare("eq", sum, v.const(0));

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.select(zf, v.const(1), v.const(0))
  );
});

test("pushfd reuses pending arithmetic flags and reads non-arithmetic flags", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1003));
  builder.addInstruction(pushfdSemantic(), [], loc(0x1003, 0x1004));

  const block = builder.finish();
  const flagReads = entryActions(block).flatMap((action) =>
    action.kind === "readState" && action.slot.kind === "flag" ? [action.slot.flag] : []
  );

  deepStrictEqual(flagReads, ["TF", "DF", "NT", "AC", "ID"]);
  deepStrictEqual([...writtenFlags(block)], []);

  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;

  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(1) });
});

test("popfd writes every stored flag from the popped image", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popfdSemantic(), [], loc(0x1000, 0x1001));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const espRead = actions.find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  );
  const popRead = actions.find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  );

  ok(espRead !== undefined, "expected popfd to read esp");
  ok(popRead !== undefined, "expected popfd to read stack memory");
  strictEqual(
    actions.filter((action) => action.kind === "readState" && action.slot.kind === "flag").length,
    0
  );

  const writes = stateWrites(block);
  const flagWrites = flagWriteEntries(block);

  strictEqual(writes[0]?.slot, gprChannel("esp"));
  strictEqual(writes[0]?.value, v.binary("add", espRead.output, v.const(4)));
  deepStrictEqual(flagWrites.map((write) => write.flag).sort(), [...x86Flags].sort());
  strictEqual(new Set(flagWrites.map((write) => write.flag)).size, x86Flags.length);

  for (const write of flagWrites) {
    const offset = x86EflagsBitOffset[write.flag];
    const shifted: ValueId = offset === 0
      ? popRead.output
      : v.binary("shr_u", popRead.output, v.const(offset));

    strictEqual(write.value, v.binary("and", shifted, v.const(1)), write.flag);
  }
});

test("set to an imm operand binding fails loudly", () => {
  const setImm: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.const32(1), 32);
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(setImm, [immBinding(0)], loc(0x1000, 0x1006)),
    /not supported by IR block builder yet/
  );
});

test("a template width that disagrees with its register binding fails loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(
        movSemantic(8),
        [regBinding("eax"), immBinding(1)],
        loc(0x1000, 0x1002)
      ),
    /8-bit set to a 32-bit register channel/
  );
});

test("a failed instruction poisons the builder, discarding its partial pendings", () => {
  const builder = createIrBlockBuilder();
  const setThenFail: Parameters<typeof builder.addInstruction>[0] = (s) => {
    s.set(s.operand(0), s.const32(1), 32);
    s.set(s.operand(1), s.const32(2), 32);
  };

  throws(
    () =>
      builder.addInstruction(setThenFail, [regBinding("eax"), immBinding(0)], loc(0x1000, 0x1002)),
    /not supported by IR block builder yet/
  );
  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1002, 0x1007)),
    /incomplete instruction/
  );
  throws(() => builder.finish(), /incomplete instruction/);
});

test("a builder with no instructions cannot finish", () => {
  throws(() => createIrBlockBuilder().finish(), /no instructions were added/);
});

test("missing operand bindings fail loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(movSemantic(32), [regBinding("eax")], loc(0x1000, 0x1005)),
    /missing operand binding for operand 1/
  );
});

test("a finished builder rejects further use", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], loc(0x1000, 0x1005));
  builder.finish();

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], loc(0x1005, 0x100a)),
    /finished IR block builder/
  );
  throws(() => builder.finish(), /already finished/);
});

test("mov [ebx+8], eax guards before the store and flushes eip into the fault edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!;
  const ebx = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;
  const address = v.binary("add", ebx.output, v.const(8));

  strictEqual(block.regions.length, 2);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: eax.output, slot: gprChannel("eax") },
    { kind: "readState", output: ebx.output, slot: gprChannel("ebx") },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 1 },
    { kind: "writeMemory", address, value: eax.output, width: 32 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1003) },
    { kind: "dispatch", targetEip: v.const(0x1003) }
  ]);

  const edge = edgeRegion(block, 1);

  strictEqual(edge.id, 1);
  deepStrictEqual(edge.flushes, [
    { kind: "writeState", slot: eipChannel, value: v.const(0x1000) }
  ]);
  deepStrictEqual(edge.terminator, { kind: "exit", reason: "memoryWriteFault", payload: address });
});

test("add [ebx], r32 lowers paired guards exactly as the semantics emit them", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("ecx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const guards = actions.filter((action): action is GuardMemoryAction => action.kind === "guardMemory");

  // guardStorageReadWrite emits a read guard then a write guard, both on the
  // base-register read (scale 1 and disp 0 add no terms).
  const address = actions.find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;
  deepStrictEqual(guards, [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 2 }
  ]);

  const readIndex = actions.findIndex((action) => action.kind === "readMemory");
  const writeIndex = actions.findIndex((action) => action.kind === "writeMemory");
  const lastGuardIndex = actions.lastIndexOf(guards[1]!);

  ok(lastGuardIndex < readIndex && readIndex < writeIndex, "guards, then the load, then the store");

  // The store carries the sum of the loaded value and the ecx read.
  const loaded = (actions[readIndex] as ReadMemoryAction).output;
  const ecx = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ecx")
  )[0]!.output;

  deepStrictEqual(actions[writeIndex], {
    kind: "writeMemory",
    address,
    value: v.binary("add", loaded, ecx),
    width: 32
  });

  // Each guard owns an edge with its own fault reason; nothing was pending
  // at guard time, so both flush only the instruction's eip.
  const eipFlushes = [{ kind: "writeState", slot: eipChannel, value: v.const(0x1000) }];

  deepStrictEqual(edgeRegion(block, 1).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 1).terminator, { kind: "exit", reason: "memoryReadFault", payload: address });
  deepStrictEqual(edgeRegion(block, 2).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 2).terminator, { kind: "exit", reason: "memoryWriteFault", payload: address });
});

test("a later guard's edge flushes earlier pendings with the faulting eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    loc(0x1003, 0x1006)
  );

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const ebxRead = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;
  const address = v.binary("add", ebxRead.output, v.const(8));

  strictEqual(block.regions.length, 2);

  // The edge snapshots everything dirty at the guard: the add's lazy flag
  // record, eax sum, and the faulting instruction's eip.
  const flushes = edgeFlushes(block, 1);

  strictEqual(flushes.length, 5);
  deepStrictEqual(flushes.flatMap((flush) => flush.slot.kind === "flag" ? [flush.slot.flag] : []), []);
  assertLazyRecord(flushes, v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });
  strictEqual(edgeWriteFlushes(block, 1).find((write) => write.slot === gprChannel("eax"))?.value, sum);
  strictEqual(edgeWriteFlushes(block, 1).find((write) => write.slot === eipChannel)?.value, v.const(0x1003));
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: address
  });

  // The edge flush leaves the main-path map untouched: the entry still
  // stores the sum and the store's value is the pending sum, not a reload.
  const mainWrites = stateWrites(block);

  strictEqual(mainWrites.find((write) => write.slot === gprChannel("eax"))?.value, sum);
  strictEqual(mainWrites.find((write) => write.slot === eipChannel)?.value, v.const(0x1006));
  deepStrictEqual(entryActions(block).at(-1), { kind: "dispatch", targetEip: v.const(0x1006) });

  const store = entryActions(block).find(
    (action): action is WriteMemoryAction => action.kind === "writeMemory"
  )!;

  strictEqual(store.value, sum);
});

test("lea builds general modrm addresses from channel reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    leaSemantic(32),
    [regBinding("eax"), memBinding({ base: "ebx", index: "esi", scale: 4, disp: 0x10 })],
    loc(0x1000, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;
  // base + (index << 2) + disp, with no guard and no memory access.
  const ebx = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;
  const esi = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esi")
  )!.output;
  const scaled = v.binary("shl", esi, v.const(2));
  const address = v.binary("add", v.binary("add", ebx, scaled), v.const(0x10));

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: ebx, slot: gprChannel("ebx") },
    { kind: "readState", output: esi, slot: gprChannel("esi") },
    { kind: "writeState", slot: gprChannel("eax"), value: address },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1007) },
    { kind: "dispatch", targetEip: v.const(0x1007) }
  ]);
});

test("an absolute address is just its displacement constant", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memBinding({ scale: 1, disp: 0x2000 })],
    loc(0x1000, 0x1005)
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1005) },
    { kind: "dispatch", targetEip: v.const(0x1005) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.const(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, { kind: "exit", reason: "memoryReadFault", payload: address });
});

test("movzx r32, byte [mem] forwards the unsigned load unmasked", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movzxSemantic(8, 32),
    [regBinding("eax"), memBinding({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!;
  const address = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(read, { kind: "readMemory", output: read.output, address, width: 8 });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, read.output);
  ok(!nodeKinds(block).includes("project"), "no projections expected");
});

test("movsx r32, byte [mem] marks the load signed with no extra extend", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movsxSemantic(8, 32),
    [regBinding("eax"), memBinding({ base: "ebx", scale: 1, disp: 0 })],
    loc(0x1000, 0x1003)
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!;
  const address = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;

  deepStrictEqual(read, {
    kind: "readMemory",
    output: read.output,
    address,
    width: 8,
    signed: true
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, read.output);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("xchg [ebx], ebx stores through the original address, not the new ebx", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    xchgSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("ebx")],
    loc(0x1000, 0x1002)
  );

  const block = builder.finish();
  const v = block.values;
  const ebx = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;
  const load = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!.output;

  // The effective address is computed once, before the instruction writes
  // ebx: the store address and value are the original ebx read, and the
  // register flush carries the loaded value.
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: ebx, slot: gprChannel("ebx") },
    { kind: "guardMemory", address: ebx, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address: ebx, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "readMemory", output: load, address: ebx, width: 32 },
    { kind: "writeMemory", address: ebx, value: ebx, width: 32 },
    { kind: "writeState", slot: gprChannel("ebx"), value: load },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);
});

test("get and set through s.mem lower to memory actions at the given address", () => {
  const incMem: SemanticTemplate = (s) => {
    const address = s.const32(0x2000);
    const target = s.mem(address);

    s.memoryGuard(address, 4, "read");
    s.memoryGuard(address, 4, "write");
    s.set(target, s.i32Add(s.get(target, 32), s.const32(1)), 32);
  };
  const builder = createIrBlockBuilder();

  builder.addInstruction(incMem, [], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = v.const(0x2000);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeMemory", address, value: v.binary("add", 2, v.const(1)), width: 32 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1006) },
    { kind: "dispatch", targetEip: v.const(0x1006) }
  ]);
});

test("address of a non-mem operand binding fails loudly", () => {
  throws(
    () =>
      createIrBlockBuilder().addInstruction(
        leaSemantic(32),
        [regBinding("eax"), regBinding("ebx")],
        loc(0x1000, 0x1002)
      ),
    /address of a reg operand binding/
  );
});

// Writes a register, then guards — the pop r/m32 shape, where the
// destination EA depends on the already-updated register.
const setRegThenStore: SemanticTemplate = (s) => {
  const address = s.const32(0x2000);

  s.set(s.operand(0), s.const32(0x222), 32);
  s.memoryGuard(address, 4, "write");
  s.set(s.mem(address), s.get(s.operand(0), 32), 32);
};

test("a guard after a register write restores the pre-instruction value in its edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x111)], loc(0x1000, 0x1005));
  builder.addInstruction(setRegThenStore, [regBinding("eax")], loc(0x1005, 0x100b));

  const block = builder.finish();
  const v = block.values;

  // The edge flushes eax's value as of instruction start — never the 0x222
  // this instruction wrote before guarding.
  deepStrictEqual(edgeFlushes(block, 1), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(0x111) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1005) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: v.const(0x2000)
  });

  // The main path keeps the new value: the store and the flush carry 0x222.
  const store = entryActions(block).find(
    (action): action is WriteMemoryAction => action.kind === "writeMemory"
  )!;

  strictEqual(store.value, v.const(0x222));
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, v.const(0x222));
});

test("a guard after writing a previously-clean register omits the channel from its edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(setRegThenStore, [regBinding("eax")], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;

  // eax had no pending at instruction start: cpu state memory already holds the
  // right bytes, so the edge writes only the eip.
  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.const(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: v.const(0x2000)
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, v.const(0x222));
});

test("pop [ebx] guards the stack read first and omits boundary-absent esp from its write edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "ebx", scale: 1, disp: 0 })], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  )!.output;
  const ebx = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  strictEqual(block.regions.length, 3);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: esp, slot: gprChannel("esp") },
    { kind: "guardMemory", address: esp, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: popValue, address: esp, width: 32 },
    { kind: "readState", output: ebx, slot: gprChannel("ebx") },
    { kind: "guardMemory", address: ebx, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "writeMemory", address: ebx, value: popValue, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);

  // esp was boundary-absent, so neither edge writes it — not even the write
  // guard's, where esp is already pending with the incremented value.
  const eipFlushes = [{ kind: "writeState", slot: eipChannel, value: v.const(0x1000) }];

  deepStrictEqual(edgeRegion(block, 1).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 1).terminator, { kind: "exit", reason: "memoryReadFault", payload: esp });
  deepStrictEqual(edgeRegion(block, 2).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 2).terminator, { kind: "exit", reason: "memoryWriteFault", payload: ebx });
});

test("pop [ebx] write edge restores a previous instruction's pending esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("esp"), immBinding(0x30)], loc(0x1000, 0x1005));
  builder.addInstruction(popSemantic(), [memBinding({ base: "ebx", scale: 1, disp: 0 })], loc(0x1005, 0x1007));

  const block = builder.finish();
  const v = block.values;
  const ebxRead = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;

  // The edge restores the boundary esp — the mov's 0x30, not the pop's
  // incremented value.
  deepStrictEqual(edgeFlushes(block, 2), [
    { kind: "writeState", slot: gprChannel("esp"), value: v.const(0x30) },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1005) }
  ]);
  deepStrictEqual(edgeRegion(block, 2).terminator, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: ebxRead.output
  });
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("esp"))?.value,
    v.binary("add", v.const(0x30), v.const(4))
  );
});

test("pop [esp] builds the destination address from the incremented esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "esp", scale: 1, disp: 0 })], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: esp, slot: gprChannel("esp") },
    { kind: "guardMemory", address: esp, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: popValue, address: esp, width: 32 },
    { kind: "guardMemory", address: nextEsp, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "writeMemory", address: nextEsp, value: popValue, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1003) },
    { kind: "dispatch", targetEip: v.const(0x1003) }
  ]);
});

test("pop [esp+k] adds the displacement to the incremented esp", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "esp", scale: 1, disp: 8 })], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  )!.output;
  const address = v.binary("add", v.binary("add", esp, v.const(4)), v.const(8));
  const writeGuard = entryActions(block).find(
    (action): action is GuardMemoryAction => action.kind === "guardMemory" && action.access === "write"
  )!;
  const store = entryActions(block).find(
    (action): action is WriteMemoryAction => action.kind === "writeMemory"
  )!;

  strictEqual(writeGuard.address, address);
  strictEqual(store.address, address);
});

test("a guard after a memory write in the same instruction fails loudly", () => {
  const storeThenGuard: SemanticTemplate = (s) => {
    const firstAddress = s.const32(0x2000);

    s.memoryGuard(firstAddress, 4, "write");
    s.set(s.mem(firstAddress), s.const32(1), 32);
    s.memoryGuard(s.const32(0x3000), 4, "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(storeThenGuard, [], loc(0x1000, 0x1006)),
    /cannot follow a memory write/
  );
});

test("a guard after flushing a channel first written this instruction fails loudly", () => {
  const flushThenGuard: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.const32(1), 8);
    s.get(s.operand(1), 16);
    s.memoryGuard(s.const32(0x2000), 4, "read");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(flushThenGuard, [regBinding("al"), regBinding("ax")], loc(0x1000, 0x1003)),
    /unrestorable/
  );
});

test("add r/m32, r32 with both operands dynamic reads, then writes, in one block", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const dst = v.external(0);
  const src = v.external(1);
  const actions = entryActions(block);
  const reads = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );
  const sum = v.binary("add", reads[0]!.output, reads[1]!.output);

  strictEqual(block.regions.length, 1);
  deepStrictEqual(block.values.node(dst), { kind: "external", external: 0 });
  deepStrictEqual(actions[0], {
    kind: "readState",
    output: reads[0]!.output,
    slot: { kind: "gprDynamic", index: dst, byteLength: 4 }
  });
  deepStrictEqual(actions[1], {
    kind: "readState",
    output: reads[1]!.output,
    slot: { kind: "gprDynamic", index: src, byteLength: 4 }
  });
  deepStrictEqual(actions[2], {
    kind: "writeState",
    slot: { kind: "gprDynamic", index: dst, byteLength: 4 },
    value: sum
  });

  // Lazy flags commit from the dynamic reads exactly as from static ones.
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: reads[0]!.output, right: reads[1]!.output });
});

test("a static register read keeps its order across a dynamic write", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ebx")], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const read = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: read.output, slot: gprChannel("ebx") },
    {
      kind: "writeState",
      slot: { kind: "gprDynamic", index: v.external(0), byteLength: 4 },
      value: read.output
    },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);
});

test("dirty GPR pendings flush before dynamic access; flags and eip ride through", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], loc(0x1000, 0x1003));
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ecx")], loc(0x1003, 0x1005));

  const block = builder.finish();
  const v = block.values;
  const eax = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  )!.output;
  const sum = v.binary("add", eax, v.const(5));
  const actions = entryActions(block);
  const eaxFlush = actions.findIndex((a) => a.kind === "writeState" && a.slot === gprChannel("eax"));
  const dynamicWrite = actions.findIndex((a) => a.kind === "writeState" && a.slot.kind === "gprDynamic");
  const lazyKindFlush = actions.findIndex((a) => a.kind === "writeState" && a.slot === lazyFlagsKindChannel);

  ok(eaxFlush !== -1 && dynamicWrite !== -1, "expected an eax flush and a dynamic write");
  ok(eaxFlush < dynamicWrite, "the dirty eax pending must flush before the dynamic write");
  ok(dynamicWrite < lazyKindFlush, "lazy flags ride through and flush at the end");
  strictEqual(stateWrites(block).filter((write) => write.slot === gprChannel("eax")).length, 1);
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, sum);
  deepStrictEqual([...writtenFlags(block)], []);
  assertLazyRecord(stateWrites(block), v, { kind: "ADD", width: 32, left: eax, right: v.const(5) });

  const eipWrites = stateWrites(block).filter((write) => write.slot === eipChannel);

  strictEqual(eipWrites.length, 1);
  strictEqual(eipWrites[0]!.value, v.const(0x1005));
});

test("a dynamic write invalidates static GPR pendings for later instructions", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), immBinding(5)], loc(0x1005, 0x100b));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const actions = entryActions(block);
  const eaxReads = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("eax")
  );
  const dynamicWrite = actions.findIndex(
    (action) => action.kind === "writeState" && action.slot.kind === "gprDynamic"
  );

  // The dynamic write may have hit eax's word, so the third mov reloads it.
  strictEqual(eaxReads.length, 1);
  ok(actions.indexOf(eaxReads[0]!) > dynamicWrite, "the eax reload must follow the dynamic write");
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("ebx"))?.value,
    eaxReads[0]!.output
  );
});

test("a dynamic read leaves flushed pendings serving later static reads", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regDynamicBinding(0)], loc(0x1005, 0x100b));
  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("eax")], loc(0x100b, 0x100d));

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // The dynamic read flushed eax once and left it clean: the third mov is
  // served from the pending with no reload and no second store.
  strictEqual(stateWrites(block).filter((write) => write.slot === gprChannel("eax")).length, 1);
  strictEqual(
    actions.filter((action) => action.kind === "readState" && action.slot === gprChannel("eax")).length,
    0
  );
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("ecx"))?.value,
    v.const(0x77)
  );
});

test("pop r/mDyn flushes the incremented esp before the dynamic store, after the guard", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));

  // Values-first: the guard (and its snapshot) precedes the esp flush the
  // dynamic store forces, so the unrestorable store happens after the last
  // fault edge.
  strictEqual(block.regions.length, 2);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: esp, slot: gprChannel("esp") },
    { kind: "guardMemory", address: esp, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: popValue, address: esp, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    {
      kind: "writeState",
      slot: { kind: "gprDynamic", index: v.external(0), byteLength: 4 },
      value: popValue
    },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);
});

test("an 8-bit template width lowers a one-byte dynamic slot", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regDynamicBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    {
      kind: "readState",
      output: 2,
      slot: { kind: "gprDynamic", index: v.external(0), byteLength: 1 }
    },
    { kind: "writeState", slot: gprChannel("bl"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1002) },
    { kind: "dispatch", targetEip: v.const(0x1002) }
  ]);
});

test("a 16-bit set through a dynamic register stores a two-byte slot", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(16), [regDynamicBinding(0), immBinding(0x1234)], loc(0x1000, 0x1004));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], {
    kind: "writeState",
    slot: { kind: "gprDynamic", index: v.external(0), byteLength: 2 },
    value: v.const(0x1234)
  });
});

test("movsx r32, r8 from a dynamic register marks the read signed with no extra extend", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), regDynamicBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], {
    kind: "readState",
    output: 2,
    slot: { kind: "gprDynamic", index: v.external(0), byteLength: 1 },
    signed: true
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, 2);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("a guard after a dynamic flush of an instruction-written register fails loudly", () => {
  const setThenDynamicRead: SemanticTemplate = (s) => {
    s.set(s.reg("ebx"), s.const32(0x111), 32);
    s.get(s.operand(0), 32);
    s.memoryGuard(s.const32(0x2000), 4, "read");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(setThenDynamicRead, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("a guard after a dynamic write fails loudly", () => {
  const dynamicWriteThenGuard: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.const32(0x222), 32);
    s.memoryGuard(s.const32(0x2000), 4, "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(dynamicWriteThenGuard, [regDynamicBinding(0)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("an external location flushes eip as the nextEip external", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), immBinding(5)],
    externalInstructionLocation(0, 1)
  );

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.const(5) },
    { kind: "writeState", slot: eipChannel, value: v.external(1) },
    { kind: "dispatch", targetEip: v.external(1) }
  ]);
});

test("a fault edge restores an external eip", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memBinding({ scale: 1, disp: 0x2000 })],
    externalInstructionLocation(4, 5)
  );

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.external(4) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryReadFault",
    payload: v.const(0x2000)
  });
  strictEqual(stateWrites(block).find((write) => write.slot === eipChannel)?.value, v.external(5));
  deepStrictEqual(entryActions(block).at(-1), { kind: "dispatch", targetEip: v.external(5) });
});

// The memDynamic address: the in-block base register read plus the
// pre-summed offset external.
function dynamicAddress(block: IrBlock, baseRead: ReadStateAction): ValueId {
  const v = block.values;

  return v.binary("add", baseRead.output, v.external(1));
}

function dynamicBaseRead(block: IrBlock): ReadStateAction {
  const read = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot.kind === "gprDynamic"
  );

  ok(read !== undefined, "expected a dynamic base register read");
  return read;
}

test("a memStatic operand guards and accesses the external address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), memStaticBinding(7)], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const address = v.external(7);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1006) },
    { kind: "dispatch", targetEip: v.const(0x1006) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryReadFault",
    payload: address
  });
});

test("a memDynamic operand reads the base register inside the block", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), memDynamicBinding(0, 1)], loc(0x1000, 0x1006));

  const block = builder.finish();
  const v = block.values;
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);
  const load = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!;

  deepStrictEqual(entryActions(block), [
    {
      kind: "readState",
      output: baseRead.output,
      slot: { kind: "gprDynamic", index: v.external(0), byteLength: 4 }
    },
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: load.output, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: load.output },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1006) },
    { kind: "dispatch", targetEip: v.const(0x1006) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, {
    kind: "exit",
    reason: "memoryReadFault",
    payload: address
  });
});

test("a read+write memDynamic operand reads the base once and reuses the address", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(aluSemantic("add", 32), [memDynamicBinding(0, 1), immBinding(5)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const actions = entryActions(block);
  const baseReads = actions.filter(
    (action) => action.kind === "readState" && action.slot.kind === "gprDynamic"
  );
  const load = actions.find((action): action is ReadMemoryAction => action.kind === "readMemory")!;
  const store = actions.find((action): action is WriteMemoryAction => action.kind === "writeMemory")!;

  strictEqual(baseReads.length, 1);
  strictEqual(load.address, dynamicAddress(block, dynamicBaseRead(block)));
  strictEqual(store.address, load.address);
});

test("pop [memDynamic] flushes esp before the base read and restores it on the write edge", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(popSemantic(), [memDynamicBinding(0, 1)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const esp = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("esp")
  )!.output;
  const popValue = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!.output;
  const nextEsp = v.binary("add", esp, v.const(4));
  const baseRead = dynamicBaseRead(block);
  const address = dynamicAddress(block, baseRead);

  // The main path stores the incremented esp before the base read, so an
  // esp-based destination follows the SDM; the value comes from the
  // pre-increment esp read.
  strictEqual(block.regions.length, 3);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: esp, slot: gprChannel("esp") },
    { kind: "guardMemory", address: esp, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: popValue, address: esp, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    { kind: "readState", output: baseRead.output, slot: baseRead.slot },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "writeMemory", address, value: popValue, width: 32 },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1003) },
    { kind: "dispatch", targetEip: v.const(0x1003) }
  ]);

  // The read guard predates the flush: its edge omits esp (cpu state memory
  // still holds it on that path). The write guard's edge restores the
  // pre-instruction esp read the flush destroyed.
  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.const(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).terminator, { kind: "exit", reason: "memoryReadFault", payload: esp });
  deepStrictEqual(edgeFlushes(block, 2), [
    { kind: "writeState", slot: gprChannel("esp"), value: esp },
    { kind: "writeState", slot: eipChannel, value: v.const(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 2).terminator, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: address
  });
});

test("a guard after a memDynamic flush of a never-read register fails loudly", () => {
  const blindWriteThenDynamicAddress: SemanticTemplate = (s) => {
    s.set(s.reg("ebx"), s.const32(0x111), 32);
    s.memoryGuard(s.address(s.operand(0)), 4, "write");
  };

  throws(
    () =>
      createIrBlockBuilder().addInstruction(blindWriteThenDynamicAddress, [memDynamicBinding(0, 1)], loc(0x1000, 0x1002)),
    /unrestorable/
  );
});

test("a narrow immExternal get projects to the access width", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), immExternalBinding(0)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.slot === gprChannel("bl"));

  deepStrictEqual(v.node(write!.value), {
    kind: "project",
    width: 8,
    value: v.external(0)
  });
});

test("a signed immExternal get sign-extends instead of masking", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), immExternalBinding(0)], loc(0x1000, 0x1003));

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.slot === gprChannel("eax"));

  deepStrictEqual(v.node(write!.value), {
    kind: "unary",
    operator: "extend8_s",
    value: v.external(0)
  });
});

function instructionCountRead(block: IrBlock): ReadStateAction {
  const read = rawEntryActions(block).find(
    (action): action is ReadStateAction =>
      action.kind === "readState" && action.slot === instructionCountChannel
  );

  ok(read !== undefined, "expected an instruction-count read");
  return read;
}

test("every instruction advances the count channel once, flushed once", () => {
  const builder = createIrBlockBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], loc(0x1000, 0x1005));
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(9)], loc(0x1005, 0x100a));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryActions(block).filter(
    (action): action is WriteStateAction =>
      action.kind === "writeState" && action.slot === instructionCountChannel
  );

  // Both advances fold onto the block's one count read.
  deepStrictEqual(writes, [
    {
      kind: "writeState",
      slot: instructionCountChannel,
      value: v.binary("add", instructionCountRead(block).output, v.const(2))
    }
  ]);
});

test("branch edges flush the advanced count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const advanced = v.binary("add", instructionCountRead(block).output, v.const(1));

  for (const index of [1, 2]) {
    strictEqual(
      edgeRegion(block, index).flushes.find(
        (flush): flush is WriteStateAction =>
          flush.kind === "writeState" && flush.slot === instructionCountChannel
      )?.value,
      advanced
    );
  }
});

test("a fault edge restores the boundary count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], loc(0x1000, 0x1005));
  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("eax")],
    loc(0x1005, 0x1007)
  );

  const block = builder.finish();
  const v = block.values;

  // The faulting store's own advance never reaches the edge: it restores the
  // first instruction's count.
  strictEqual(
    edgeRegion(block, 1).flushes.find(
      (flush): flush is WriteStateAction =>
        flush.kind === "writeState" && flush.slot === instructionCountChannel
    )?.value,
    v.binary("add", instructionCountRead(block).output, v.const(1))
  );
});

test("a host trap flushes the advanced count", () => {
  const builder = createIrBlockBuilder();

  builder.addInstruction(intSemantic(), [immBinding(0x21)], loc(0x1000, 0x1002));

  const block = builder.finish();
  const v = block.values;
  const writes = rawEntryActions(block).filter(
    (action): action is WriteStateAction =>
      action.kind === "writeState" && action.slot === instructionCountChannel
  );

  deepStrictEqual(writes, [
    {
      kind: "writeState",
      slot: instructionCountChannel,
      value: v.binary("add", instructionCountRead(block).output, v.const(1))
    }
  ]);
});
