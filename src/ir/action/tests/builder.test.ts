import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createActionBuilder } from "#ir/action/builder.js";
import {
  immBinding,
  immExternalBinding,
  memBinding,
  memExternalBinding,
  regBinding,
  regDynamicBinding
} from "#ir/action/operands.js";
import { eipChannel, flagChannel, gprChannel, instructionCountChannel } from "#ir/action/slots.js";
import type {
  Action,
  ActionBlock,
  EdgeRegion,
  GuardMemoryAction,
  ReadMemoryAction,
  ReadStateAction,
  WriteMemoryAction,
  WriteStateAction
} from "#ir/action/types.js";
import type { ValueId, ValueNode } from "#ir/action/values.js";
import type { FlagName } from "#ir/model/flags.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { jccSemantic, jmpSemantic } from "#x86/semantics/control.js";
import { leaSemantic } from "#x86/semantics/lea.js";
import { intSemantic } from "#x86/semantics/misc.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#x86/semantics/mov.js";
import { setccSemantic } from "#x86/semantics/setcc.js";
import { popSemantic } from "#x86/semantics/stack.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";

// Every instruction advances the count channel; the dedicated tests at the
// end cover that bookkeeping, the shape tests assert around it.
function isInstructionCountAction(action: Action): boolean {
  switch (action.kind) {
    case "readState":
    case "writeState":
      return action.slot.kind === "instructionCount";
    default:
      return false;
  }
}

function entryActions(block: ActionBlock): readonly Action[] {
  return rawEntryActions(block).filter((action) => !isInstructionCountAction(action));
}

function rawEntryActions(block: ActionBlock): readonly Action[] {
  const entry = block.regions[0]!;

  ok(entry.kind === "entry", "first region is the entry");
  return entry.actions;
}

function edgeRegion(block: ActionBlock, index: number): EdgeRegion {
  const region = block.regions[index]!;

  ok(region.kind === "edge", `region ${index} is an edge`);
  return region;
}

function edgeFlushes(block: ActionBlock, index: number): WriteStateAction[] {
  return edgeRegion(block, index).flushes.filter((flush) => !isInstructionCountAction(flush));
}

function stateWrites(block: ActionBlock): WriteStateAction[] {
  return entryActions(block).filter(
    (action): action is WriteStateAction => action.kind === "writeState"
  );
}

function nodeKinds(block: ActionBlock): ValueNode["kind"][] {
  const kinds: ValueNode["kind"][] = [];

  for (let id = 0; id < block.values.size(); id += 1) {
    kinds.push(block.values.node(id).kind);
  }

  return kinds;
}

function writtenFlags(block: ActionBlock): FlagName[] {
  return stateWrites(block).flatMap((write) => (write.slot.kind === "flag" ? [write.slot.flag] : []));
}

function flagWriteValue(block: ActionBlock, flag: FlagName): ValueId {
  const writes = stateWrites(block).filter((write) => write.slot === flagChannel(flag));

  strictEqual(writes.length, 1, `expected exactly one ${flag} write`);
  return writes[0]!.value;
}

test("mov r32, imm32 flushes the register write, the eip advance, and a next exit", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], {
    eip: 0x401000,
    nextEip: 0x401005
  });

  const block = builder.finish();
  const v = block.values;

  strictEqual(block.regions.length, 1);

  const entry = block.regions[0]!;

  strictEqual(entry.id, block.entry);
  strictEqual(entry.kind, "entry");
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x12345678) },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x401005) },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(v.node(0), { kind: "const", value: 0x12345678 });
  // The two constants plus the count advance — nothing else was created.
  strictEqual(v.size(), 5);
});

test("pending writes overwrite per channel and consts intern across instructions", () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], { eip: 0x1000, nextEip: 0x1005 });
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(7)], { eip: 0x1005, nextEip: 0x100a });
  builder.addInstruction(mov, [regBinding("eax"), immBinding(9)], { eip: 0x100a, nextEip: 0x100f });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: block.values.internConst(9) },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x100f) },
    { kind: "writeState", slot: gprChannel("ecx"), value: block.values.internConst(7) },
    { kind: "exit", reason: "next" }
  ]);

  // 7, 9, the three eip constants, and the count read with its three folded
  // advances — both movs of 7 share one const.
  strictEqual(block.values.size(), 12);
});

test("mov r32, r32 records one readState and forwards its leaf", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(v.node(0), { kind: "actionOutput" });
  // The read leaf, the eip constant, and the count advance — nothing else.
  strictEqual(v.size(), 5);
});

test("repeated get of an unwritten channel returns the same leaf across instructions", () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], { eip: 0x1000, nextEip: 0x1002 });
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("eax")], { eip: 0x1002, nextEip: 0x1004 });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1004) },
    { kind: "writeState", slot: gprChannel("ecx"), value: 0 },
    { kind: "exit", reason: "next" }
  ]);
});

test("add eax, imm32 writes all six arithmetic flags as pending expressions", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), [...x86ArithmeticFlags].sort());

  // Spot-check through re-interning: ZF compares the sum against zero, and
  // the register write shares the same sum node.
  const v = block.values;
  const sum = v.internBinary("add", 0, v.internConst(5));

  strictEqual(flagWriteValue(block, "ZF"), v.internCompare("eq", sum, v.internConst(0)));
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, sum);
});

test("two adds in one block flush exactly one write per channel, second instruction wins", () => {
  const builder = createActionBuilder();
  const add = aluSemantic("add", 32);

  builder.addInstruction(add, [regBinding("eax"), immBinding(5)], { eip: 0x1000, nextEip: 0x1003 });
  builder.addInstruction(add, [regBinding("eax"), immBinding(7)], { eip: 0x1003, nextEip: 0x1006 });

  const block = builder.finish();
  const actions = entryActions(block);
  const writes = stateWrites(block);

  // One read feeds both adds; one flush per channel: six flags + eax + eip.
  strictEqual(actions.filter((action) => action.kind === "readState").length, 1);
  strictEqual(writes.length, 8);
  strictEqual(new Set(writes.map((write) => write.slot)).size, 8);

  const v = block.values;
  const sum1 = v.internBinary("add", 0, v.internConst(5));
  const sum2 = v.internBinary("add", sum1, v.internConst(7));

  strictEqual(writes.find((write) => write.slot === gprChannel("eax"))?.value, sum2);
  strictEqual(flagWriteValue(block, "ZF"), v.internCompare("eq", sum2, v.internConst(0)));
});

test("inc leaves CF unwritten", () => {
  const builder = createActionBuilder();

  builder.addInstruction(unaryAluSemantic("inc", 32), [regBinding("eax")], {
    eip: 0x1000,
    nextEip: 0x1001
  });

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), ["AF", "OF", "PF", "SF", "ZF"]);
});

test("cmp writes flags but no register", () => {
  const builder = createActionBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const writes = stateWrites(block);

  deepStrictEqual([...writtenFlags(block)].sort(), [...x86ArithmeticFlags].sort());
  strictEqual(writes.some((write) => write.slot.kind === "gpr"), false);
  strictEqual(writes.filter((write) => write.slot === eipChannel).length, 1);
});

// A template writing ZF and leaving AF undefined; no ISA template marks
// flags undef anymore, but the builder contract (undef = preserve) stays.
const undefAfTemplate: SemanticTemplate = (s) => {
  s.writeFlags({ cells: { ZF: s.flagExpr(1), AF: s.flagUndef() } });
};

test("flagUndef cells produce no write", () => {
  const builder = createActionBuilder();

  builder.addInstruction(undefAfTemplate, [], { eip: 0x1000, nextEip: 0x1002 });

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), ["ZF"]);
});

test("an undef cell preserves the previous instruction's pending flag", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(undefAfTemplate, [], {
    eip: 0x1003,
    nextEip: 0x1005
  });

  const block = builder.finish();

  // The second instruction leaves AF undefined, so the add's AF expression
  // survives and flushes.
  const v = block.values;
  const a = 0; // the eax readState leaf
  const b = v.internConst(5);
  const result = v.internBinary("add", a, b);
  const carryChain = v.internBinary("xor", v.internBinary("xor", a, b), result);
  const af = v.internBinary("and", v.internBinary("shr_u", carryChain, v.internConst(4)), v.internConst(1));

  strictEqual(flagWriteValue(block, "AF"), af);

  // The second instruction's constant ZF write wins over the add's expression.
  strictEqual(flagWriteValue(block, "ZF"), v.internConst(1));
});

test("xchg eax, ebx swaps pendings through two reads with no temporaries", () => {
  const builder = createActionBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "readState", output: 1, slot: gprChannel("ebx") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: gprChannel("eax"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);

  // Two read leaves, the eip constant, and the count advance — no
  // temporaries were created.
  strictEqual(block.values.size(), 6);
});

test("mov r8, r8 reads and writes byte channels with no bit algebra", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("ah") },
    { kind: "writeState", slot: gprChannel("bl"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
  // The read leaf, the eip constant, and the count advance — no masks or
  // shifts were created.
  strictEqual(block.values.size(), 5);
});

test("write al then read eax flushes the byte and reloads the word", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], {
    eip: 0x1000,
    nextEip: 0x1002
  });
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], {
    eip: 0x1002,
    nextEip: 0x1004
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("al"), value: v.internConst(0x12) },
    { kind: "readState", output: 5, slot: gprChannel("eax") },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1004) },
    { kind: "writeState", slot: gprChannel("ebx"), value: 5 },
    { kind: "exit", reason: "next" }
  ]);
});

test("write eax then read al flushes the word and reloads the byte", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("al")], {
    eip: 0x1005,
    nextEip: 0x1007
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x12345678) },
    { kind: "readState", output: 5, slot: gprChannel("al") },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1007) },
    { kind: "writeState", slot: gprChannel("bl"), value: 5 },
    { kind: "exit", reason: "next" }
  ]);
});

test("write al then write eax drops the byte pending with no flush", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("al"), immBinding(0x12)], {
    eip: 0x1000,
    nextEip: 0x1002
  });
  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], {
    eip: 0x1002,
    nextEip: 0x1007
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1007) },
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x12345678) },
    { kind: "exit", reason: "next" }
  ]);
});

test("write eax then read ah reloads through the high-byte channel", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x12345678)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], {
    eip: 0x1005,
    nextEip: 0x1007
  });

  const block = builder.finish();
  const actions = entryActions(block);

  strictEqual(actions[0]!.kind, "writeState");
  deepStrictEqual(actions[1], { kind: "readState", output: 5, slot: gprChannel("ah") });
});

test("ax and al pendings mix without touching flag pendings", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 8), [regBinding("al"), regBinding("bl")], {
    eip: 0x1000,
    nextEip: 0x1002
  });
  builder.addInstruction(movSemantic(8), [regBinding("ah"), immBinding(0x12)], {
    eip: 0x1002,
    nextEip: 0x1004
  });
  builder.addInstruction(movSemantic(16), [regBinding("cx"), regBinding("ax")], {
    eip: 0x1004,
    nextEip: 0x1007
  });

  const block = builder.finish();
  const actions = entryActions(block);
  const indexOf = (predicate: (action: (typeof actions)[number]) => boolean) =>
    actions.findIndex(predicate);

  // al and ah are disjoint, so both stay pending until the ax read flushes
  // them; the flag pendings ride through it all and flush once at the end.
  const alFlush = indexOf((a) => a.kind === "writeState" && a.slot === gprChannel("al"));
  const ahFlush = indexOf((a) => a.kind === "writeState" && a.slot === gprChannel("ah"));
  const axRead = indexOf((a) => a.kind === "readState" && a.slot === gprChannel("ax"));
  const firstFlagWrite = indexOf((a) => a.kind === "writeState" && a.slot.kind === "flag");

  ok(alFlush !== -1 && ahFlush !== -1 && axRead !== -1, "expected al/ah flushes and an ax read");
  ok(alFlush < axRead && ahFlush < axRead, "the ax read must flush al and ah first");
  ok(axRead < firstFlagWrite, "flag writes stay at the end of the block");
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86ArithmeticFlags].sort());

  // The flushed al carries the add's projected result.
  const v = block.values;
  const sum = v.internProject(8, v.internBinary("add", 0, 1));

  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value, sum);
});

test("movzx r32, r8 forwards the unsigned byte read unmasked", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movzxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("al") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1003) },
    { kind: "exit", reason: "next" }
  ]);
  strictEqual(block.values.size(), 5);
});

test("movsx r32, r8 marks the read for a sign-extending load", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("al"), signed: true },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1003) },
    { kind: "exit", reason: "next" }
  ]);
  strictEqual(block.values.size(), 5);
});

test("narrow signed compares sign-extend both operands", () => {
  const cmp8: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.compare(8, "lt_s", s.get(s.operand(0), 32), s.get(s.operand(1), 32)), 32);
  };
  const builder = createActionBuilder();

  builder.addInstruction(cmp8, [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;
  const compare = v.internCompare("lt_s", v.internUnary("extend8_s", 0), v.internUnary("extend8_s", 1));

  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, compare);
});

test("an 8-bit unsigned compare of covered operands creates no projections", () => {
  const cmpAl: SemanticTemplate = (s) => {
    s.set(s.operand(0), s.compare(8, "lt_u", s.get(s.operand(0), 8), s.get(s.operand(1), 8)), 8);
  };
  const builder = createActionBuilder();

  builder.addInstruction(cmpAl, [regBinding("al"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;

  // The al read fits unsigned 8 and the constant fits by value, so the
  // compare interns on the raw operands.
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.internCompare("lt_u", 0, v.internConst(5))
  );
  ok(!nodeKinds(block).includes("project"), "no projections expected");
});

test("an 8-bit equality on an unproven value keeps its mask", () => {
  const cmpSum: SemanticTemplate = (s) => {
    const sum = s.i32Add(s.get(s.operand(0), 8), s.get(s.operand(1), 8));

    s.set(s.operand(0), s.compare(8, "eq", sum, 0), 8);
  };
  const builder = createActionBuilder();

  builder.addInstruction(cmpSum, [regBinding("al"), regBinding("bl")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;
  const sum = v.internBinary("add", 0, 1);

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.internCompare("eq", v.internProject(8, sum), v.internConst(0))
  );
});

test("a signed byte get feeds a signed compare with no extra extends", () => {
  const cmpSigned: SemanticTemplate = (s) => {
    const a = s.get(s.operand(0), 8, { signed: true });
    const b = s.get(s.operand(1), 8, { signed: true });

    s.set(s.operand(0), s.compare(8, "lt_s", a, b), 8);
  };
  const builder = createActionBuilder();

  builder.addInstruction(cmpSigned, [regBinding("al"), regBinding("bl")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const actions = entryActions(block);

  deepStrictEqual(actions[0], { kind: "readState", output: 0, slot: gprChannel("al"), signed: true });
  deepStrictEqual(actions[1], { kind: "readState", output: 1, slot: gprChannel("bl"), signed: true });
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    block.values.internCompare("lt_s", 0, 1)
  );
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("value methods intern through the builder", () => {
  const abs: SemanticTemplate = (s) => {
    const value = s.get(s.operand(0), 32);
    const negative = s.compare(32, "lt_s", value, 0);

    s.set(s.operand(0), s.i32Select(negative, s.i32Sub(0, value), value), 32);
  };
  const builder = createActionBuilder();

  builder.addInstruction(abs, [regBinding("eax")], { eip: 0x1000, nextEip: 0x1003 });

  const block = builder.finish();

  // 0: eax leaf, 1: 0, 2: compare, 3: sub(0 - leaf), 4: select.
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: 4 },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x1003) },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(block.values.node(2), { kind: "compare", operator: "lt_s", a: 0, b: 1 });
  deepStrictEqual(block.values.node(3), { kind: "binary", operator: "sub", a: 1, b: 0 });
  deepStrictEqual(block.values.node(4), { kind: "select", condition: 2, whenTrue: 3, whenFalse: 0 });
});

test("jmp redirects the eip flush and exits jump", () => {
  const builder = createActionBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], { eip: 0x1000, nextEip: 0x1005 });

  const block = builder.finish();

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x2000) },
    { kind: "exit", reason: "jump" }
  ]);
});

test("a jump flushes earlier pendings with the target eip", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], { eip: 0x1005, nextEip: 0x100a });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x77) },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x2000) },
    { kind: "exit", reason: "jump" }
  ]);
});

test("a block ended by a jump rejects further instructions", () => {
  const builder = createActionBuilder();

  builder.addInstruction(jmpSemantic(), [immBinding(0x2000)], { eip: 0x1000, nextEip: 0x1005 });

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], {
        eip: 0x1005,
        nextEip: 0x100a
      }),
    /after a block terminator/
  );
});

test("ops after a control terminator in one template fail loudly", () => {
  const jumpThenSet: SemanticTemplate = (s) => {
    s.jump(0x2000);
    s.set(s.reg("eax"), 1, 32);
  };

  throws(
    () => createActionBuilder().addInstruction(jumpThenSet, [], { eip: 0x1000, nextEip: 0x1005 }),
    /cannot emit set after instruction terminator/
  );
});

test("jcc after cmp branches on the recorded condition with per-edge eip and flag flushes", () => {
  const builder = createActionBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], {
    eip: 0x1003,
    nextEip: 0x1005
  });

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  strictEqual(block.regions.length, 3);
  deepStrictEqual(actions[actions.length - 1], {
    kind: "branch",
    condition: v.internCompare("eq", 0, v.internConst(5)),
    taken: 1,
    notTaken: 2
  });

  // The branch is the entry's terminator: nothing flushes on the main path.
  strictEqual(stateWrites(block).length, 0);

  // Each edge flushes the cmp's six flags plus its own eip and nothing else.
  const taken = edgeFlushes(block, 1);
  const notTaken = edgeFlushes(block, 2);

  for (const flushes of [taken, notTaken]) {
    strictEqual(flushes.length, 7);
    deepStrictEqual(
      flushes.flatMap((write) => (write.slot.kind === "flag" ? [write.slot.flag] : [])).sort(),
      [...x86ArithmeticFlags].sort()
    );
  }

  strictEqual(taken.find((write) => write.slot === eipChannel)?.value, v.internConst(0x2000));
  deepStrictEqual(edgeRegion(block, 1).exit, { kind: "exit", reason: "jump" });
  strictEqual(notTaken.find((write) => write.slot === eipChannel)?.value, v.internConst(0x1005));
  deepStrictEqual(edgeRegion(block, 2).exit, { kind: "exit", reason: "next" });
});

test("int flushes pending state with the resume eip before a host trap exit", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(intSemantic(), [immBinding(0x21)], { eip: 0x1005, nextEip: 0x1007 });

  const block = builder.finish();
  const v = block.values;

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x77) },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1007) },
    { kind: "exit", reason: "hostTrap", payload: v.internConst(0x21) }
  ]);
});

test("a block ended by a host trap rejects further instructions", () => {
  const builder = createActionBuilder();

  builder.addInstruction(intSemantic(), [immBinding(3)], { eip: 0x1000, nextEip: 0x1002 });

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], {
        eip: 0x1002,
        nextEip: 0x1007
      }),
    /after a block terminator/
  );
});

test("setcc after cmp consumes the recorded condition expression", () => {
  const builder = createActionBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(setccSemantic("B"), [regBinding("al")], {
    eip: 0x1003,
    nextEip: 0x1006
  });

  const block = builder.finish();
  const v = block.values;
  // B is the cmp's lt_u over its raw operands; no flag byte is read.
  const condition = v.internCompare("lt_u", 0, v.internConst(5));

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.internSelect(condition, v.internConst(1), v.internConst(0))
  );
  strictEqual(entryActions(block).filter((action) => action.kind === "readState").length, 1);
});

test("setcc with no recorded condition builds from flag byte reads", () => {
  const builder = createActionBuilder();

  builder.addInstruction(setccSemantic("A"), [regBinding("al")], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();
  const v = block.values;
  const reads = entryActions(block).filter(
    (action): action is ReadStateAction => action.kind === "readState"
  );

  deepStrictEqual(reads.map((read) => read.slot), [flagChannel("CF"), flagChannel("ZF")]);

  // A = !CF && !ZF over the two 0/1 flag bytes.
  const zero = v.internConst(0);
  const condition = v.internBinary(
    "and",
    v.internCompare("eq", reads[0]!.output, zero),
    v.internCompare("eq", reads[1]!.output, zero)
  );

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.internSelect(condition, v.internConst(1), zero)
  );
});

test("a flag write between cmp and setcc invalidates the recorded condition", () => {
  const builder = createActionBuilder();

  builder.addInstruction(cmpSemantic(32), [regBinding("ebx"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(aluSemantic("add", 32), [regBinding("ecx"), immBinding(1)], {
    eip: 0x1003,
    nextEip: 0x1006
  });
  builder.addInstruction(setccSemantic("E"), [regBinding("al")], {
    eip: 0x1006,
    nextEip: 0x1009
  });

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);

  // E rebuilds from the add's pending ZF expression — no flag byte load.
  strictEqual(
    actions.filter((action) => action.kind === "readState" && action.slot.kind === "flag").length,
    0
  );

  const ecxRead = actions.filter(
    (action): action is ReadStateAction => action.kind === "readState"
  )[1]!.output;
  const sum = v.internBinary("add", ecxRead, v.internConst(1));
  const zf = v.internCompare("eq", sum, v.internConst(0));

  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("al"))?.value,
    v.internSelect(zf, v.internConst(1), v.internConst(0))
  );
});

test("set to an imm operand binding fails loudly", () => {
  const setImm: SemanticTemplate = (s) => {
    s.set(s.operand(0), 1, 32);
  };

  throws(
    () =>
      createActionBuilder().addInstruction(setImm, [immBinding(0)], {
        eip: 0x1000,
        nextEip: 0x1006
      }),
    /not supported by action builder yet/
  );
});

test("a template width that disagrees with its register binding fails loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(
        movSemantic(8),
        [regBinding("eax"), immBinding(1)],
        { eip: 0x1000, nextEip: 0x1002 }
      ),
    /8-bit set to a 32-bit register channel/
  );
});

test("a failed instruction poisons the builder, discarding its partial pendings", () => {
  const builder = createActionBuilder();
  const setThenFail: Parameters<typeof builder.addInstruction>[0] = (s) => {
    s.set(s.operand(0), 1, 32);
    s.set(s.operand(1), 2, 32);
  };

  throws(
    () =>
      builder.addInstruction(setThenFail, [regBinding("eax"), immBinding(0)], {
        eip: 0x1000,
        nextEip: 0x1002
      }),
    /not supported by action builder yet/
  );
  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], {
        eip: 0x1002,
        nextEip: 0x1007
      }),
    /incomplete instruction/
  );
  throws(() => builder.finish(), /incomplete instruction/);
});

test("a builder with no instructions cannot finish", () => {
  throws(() => createActionBuilder().finish(), /no instructions were added/);
});

test("missing operand bindings fail loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(movSemantic(32), [regBinding("eax")], {
        eip: 0x1000,
        nextEip: 0x1005
      }),
    /missing operand binding for operand 1/
  );
});

test("a finished builder rejects further use", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(1)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.finish();

  throws(
    () =>
      builder.addInstruction(movSemantic(32), [regBinding("ecx"), immBinding(2)], {
        eip: 0x1005,
        nextEip: 0x100a
      }),
    /finished action builder/
  );
  throws(() => builder.finish(), /already finished/);
});

test("mov [ebx+8], eax guards before the store and flushes eip into the fault edge", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    { eip: 0x1000, nextEip: 0x1003 }
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.internBinary("add", 1, v.internConst(8));

  strictEqual(block.regions.length, 2);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "readState", output: 1, slot: gprChannel("ebx") },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 1 },
    { kind: "writeMemory", address, value: 0, width: 32 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1003) },
    { kind: "exit", reason: "next" }
  ]);

  const edge = edgeRegion(block, 1);

  strictEqual(edge.id, 1);
  deepStrictEqual(edge.flushes, [
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1000) }
  ]);
  deepStrictEqual(edge.exit, { kind: "exit", reason: "memoryWriteFault", payload: address });
});

test("add [ebx], r32 lowers paired guards exactly as the semantics emit them", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    aluSemantic("add", 32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("ecx")],
    { eip: 0x1000, nextEip: 0x1002 }
  );

  const block = builder.finish();
  const v = block.values;
  const actions = entryActions(block);
  const guards = actions.filter((action): action is GuardMemoryAction => action.kind === "guardMemory");

  // guardStorageReadWrite emits a read guard then a write guard, both on the
  // base-register read (scale 1 and disp 0 add no terms).
  deepStrictEqual(guards, [
    { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "write", faultEdge: 2 }
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
    address: 0,
    value: v.internBinary("add", loaded, ecx),
    width: 32
  });

  // Each guard owns an edge with its own fault reason; nothing was pending
  // at guard time, so both flush only the instruction's eip.
  const eipFlushes = [{ kind: "writeState", slot: eipChannel, value: v.internConst(0x1000) }];

  deepStrictEqual(edgeRegion(block, 1).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 1).exit, { kind: "exit", reason: "memoryReadFault", payload: 0 });
  deepStrictEqual(edgeRegion(block, 2).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 2).exit, { kind: "exit", reason: "memoryWriteFault", payload: 0 });
});

test("a later guard's edge flushes earlier pendings with the faulting eip", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 8 }), regBinding("eax")],
    { eip: 0x1003, nextEip: 0x1006 }
  );

  const block = builder.finish();
  const v = block.values;
  const sum = v.internBinary("add", 0, v.internConst(5));
  const ebxRead = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;
  const address = v.internBinary("add", ebxRead.output, v.internConst(8));

  strictEqual(block.regions.length, 2);

  // The edge snapshots everything dirty at the guard — the add's six flags
  // and eax sum — plus the faulting instruction's eip.
  const flushes = edgeFlushes(block, 1);

  strictEqual(flushes.length, 8);
  deepStrictEqual(
    flushes.flatMap((write) => (write.slot.kind === "flag" ? [write.slot.flag] : [])).sort(),
    [...x86ArithmeticFlags].sort()
  );
  strictEqual(flushes.find((write) => write.slot === gprChannel("eax"))?.value, sum);
  strictEqual(flushes.find((write) => write.slot === eipChannel)?.value, v.internConst(0x1003));
  deepStrictEqual(edgeRegion(block, 1).exit, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: address
  });

  // The edge flush leaves the main-path map untouched: the entry still
  // stores the sum and the store's value is the pending sum, not a reload.
  const mainWrites = stateWrites(block);

  strictEqual(mainWrites.find((write) => write.slot === gprChannel("eax"))?.value, sum);
  strictEqual(mainWrites.find((write) => write.slot === eipChannel)?.value, v.internConst(0x1006));

  const store = entryActions(block).find(
    (action): action is WriteMemoryAction => action.kind === "writeMemory"
  )!;

  strictEqual(store.value, sum);
});

test("lea builds general modrm addresses from channel reads", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    leaSemantic(32),
    [regBinding("eax"), memBinding({ base: "ebx", index: "esi", scale: 4, disp: 0x10 })],
    { eip: 0x1000, nextEip: 0x1007 }
  );

  const block = builder.finish();
  const v = block.values;
  // base + (index << 2) + disp, with no guard and no memory access.
  const scaled = v.internBinary("shl", 1, v.internConst(2));
  const address = v.internBinary("add", v.internBinary("add", 0, scaled), v.internConst(0x10));

  strictEqual(block.regions.length, 1);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("ebx") },
    { kind: "readState", output: 1, slot: gprChannel("esi") },
    { kind: "writeState", slot: gprChannel("eax"), value: address },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1007) },
    { kind: "exit", reason: "next" }
  ]);
});

test("an absolute address is just its displacement constant", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memBinding({ scale: 1, disp: 0x2000 })],
    { eip: 0x1000, nextEip: 0x1005 }
  );

  const block = builder.finish();
  const v = block.values;
  const address = v.internConst(0x2000);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1005) },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).exit, { kind: "exit", reason: "memoryReadFault", payload: address });
});

test("movzx r32, byte [mem] forwards the unsigned load unmasked", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    movzxSemantic(8, 32),
    [regBinding("eax"), memBinding({ base: "ebx", scale: 1, disp: 0 })],
    { eip: 0x1000, nextEip: 0x1003 }
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!;

  deepStrictEqual(read, { kind: "readMemory", output: read.output, address: 0, width: 8 });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, read.output);
  ok(!nodeKinds(block).includes("project"), "no projections expected");
});

test("movsx r32, byte [mem] marks the load signed with no extra extend", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    movsxSemantic(8, 32),
    [regBinding("eax"), memBinding({ base: "ebx", scale: 1, disp: 0 })],
    { eip: 0x1000, nextEip: 0x1003 }
  );

  const block = builder.finish();
  const read = entryActions(block).find(
    (action): action is ReadMemoryAction => action.kind === "readMemory"
  )!;

  deepStrictEqual(read, {
    kind: "readMemory",
    output: read.output,
    address: 0,
    width: 8,
    signed: true
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, read.output);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("xchg [ebx], ebx stores through the original address, not the new ebx", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    xchgSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("ebx")],
    { eip: 0x1000, nextEip: 0x1002 }
  );

  const block = builder.finish();
  const v = block.values;

  // The effective address is computed once, before the instruction writes
  // ebx: the store address and value are the original ebx read (0), and the
  // register flush carries the loaded value (2).
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("ebx") },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "readMemory", output: 2, address: 0, width: 32 },
    { kind: "writeMemory", address: 0, value: 0, width: 32 },
    { kind: "writeState", slot: gprChannel("ebx"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
});

test("get and set through s.mem lower to memory actions at the given address", () => {
  const incMem: SemanticTemplate = (s) => {
    const target = s.mem(0x2000);

    s.memoryGuard(0x2000, 4, "read");
    s.memoryGuard(0x2000, 4, "write");
    s.set(target, s.i32Add(s.get(target, 32), 1), 32);
  };
  const builder = createActionBuilder();

  builder.addInstruction(incMem, [], { eip: 0x1000, nextEip: 0x1006 });

  const block = builder.finish();
  const v = block.values;
  const address = v.internConst(0x2000);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeMemory", address, value: v.internBinary("add", 2, v.internConst(1)), width: 32 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1006) },
    { kind: "exit", reason: "next" }
  ]);
});

test("address of a non-mem operand binding fails loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(
        leaSemantic(32),
        [regBinding("eax"), regBinding("ebx")],
        { eip: 0x1000, nextEip: 0x1002 }
      ),
    /address of a reg operand binding/
  );
});

// Writes a register, then guards — the pop r/m32 shape, where the
// destination EA depends on the already-updated register.
const setRegThenStore: SemanticTemplate = (s) => {
  s.set(s.operand(0), 0x222, 32);
  s.memoryGuard(0x2000, 4, "write");
  s.set(s.mem(0x2000), s.get(s.operand(0), 32), 32);
};

test("a guard after a register write restores the pre-instruction value in its edge", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x111)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(setRegThenStore, [regBinding("eax")], { eip: 0x1005, nextEip: 0x100b });

  const block = builder.finish();
  const v = block.values;

  // The edge flushes eax's value as of instruction start — never the 0x222
  // this instruction wrote before guarding.
  deepStrictEqual(edgeFlushes(block, 1), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x111) },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1005) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).exit, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: v.internConst(0x2000)
  });

  // The main path keeps the new value: the store and the flush carry 0x222.
  const store = entryActions(block).find(
    (action): action is WriteMemoryAction => action.kind === "writeMemory"
  )!;

  strictEqual(store.value, v.internConst(0x222));
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, v.internConst(0x222));
});

test("a guard after writing a previously-clean register omits the channel from its edge", () => {
  const builder = createActionBuilder();

  builder.addInstruction(setRegThenStore, [regBinding("eax")], { eip: 0x1000, nextEip: 0x1006 });

  const block = builder.finish();
  const v = block.values;

  // eax had no pending at instruction start: state memory already holds the
  // right bytes, so the edge writes only the eip.
  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1000) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).exit, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: v.internConst(0x2000)
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, v.internConst(0x222));
});

test("pop [ebx] guards the stack read first and omits boundary-absent esp from its write edge", () => {
  const builder = createActionBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "ebx", scale: 1, disp: 0 })], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;
  const nextEsp = v.internBinary("add", 0, v.internConst(4));

  strictEqual(block.regions.length, 3);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("esp") },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address: 0, width: 32 },
    { kind: "readState", output: 5, slot: gprChannel("ebx") },
    { kind: "guardMemory", address: 5, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "writeMemory", address: 5, value: 2, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);

  // esp was boundary-absent, so neither edge writes it — not even the write
  // guard's, where esp is already pending with the incremented value.
  const eipFlushes = [{ kind: "writeState", slot: eipChannel, value: v.internConst(0x1000) }];

  deepStrictEqual(edgeRegion(block, 1).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 1).exit, { kind: "exit", reason: "memoryReadFault", payload: 0 });
  deepStrictEqual(edgeRegion(block, 2).flushes, eipFlushes);
  deepStrictEqual(edgeRegion(block, 2).exit, { kind: "exit", reason: "memoryWriteFault", payload: 5 });
});

test("pop [ebx] write edge restores a previous instruction's pending esp", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("esp"), immBinding(0x30)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(popSemantic(), [memBinding({ base: "ebx", scale: 1, disp: 0 })], {
    eip: 0x1005,
    nextEip: 0x1007
  });

  const block = builder.finish();
  const v = block.values;
  const ebxRead = entryActions(block).find(
    (action): action is ReadStateAction => action.kind === "readState" && action.slot === gprChannel("ebx")
  )!;

  // The edge restores the boundary esp — the mov's 0x30, not the pop's
  // incremented value.
  deepStrictEqual(edgeFlushes(block, 2), [
    { kind: "writeState", slot: gprChannel("esp"), value: v.internConst(0x30) },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1005) }
  ]);
  deepStrictEqual(edgeRegion(block, 2).exit, {
    kind: "exit",
    reason: "memoryWriteFault",
    payload: ebxRead.output
  });
  strictEqual(
    stateWrites(block).find((write) => write.slot === gprChannel("esp"))?.value,
    v.internBinary("add", v.internConst(0x30), v.internConst(4))
  );
});

test("pop [esp] builds the destination address from the incremented esp", () => {
  const builder = createActionBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "esp", scale: 1, disp: 0 })], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();
  const v = block.values;
  const nextEsp = v.internBinary("add", 0, v.internConst(4));

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("esp") },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address: 0, width: 32 },
    { kind: "guardMemory", address: nextEsp, byteLength: 4, access: "write", faultEdge: 2 },
    { kind: "writeMemory", address: nextEsp, value: 2, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1003) },
    { kind: "exit", reason: "next" }
  ]);
});

test("pop [esp+k] adds the displacement to the incremented esp", () => {
  const builder = createActionBuilder();

  builder.addInstruction(popSemantic(), [memBinding({ base: "esp", scale: 1, disp: 8 })], {
    eip: 0x1000,
    nextEip: 0x1004
  });

  const block = builder.finish();
  const v = block.values;
  const address = v.internBinary("add", v.internBinary("add", 0, v.internConst(4)), v.internConst(8));
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
    s.memoryGuard(0x2000, 4, "write");
    s.set(s.mem(0x2000), 1, 32);
    s.memoryGuard(0x3000, 4, "write");
  };

  throws(
    () =>
      createActionBuilder().addInstruction(storeThenGuard, [], { eip: 0x1000, nextEip: 0x1006 }),
    /cannot follow a memory write/
  );
});

test("a guard after flushing a channel first written this instruction fails loudly", () => {
  const flushThenGuard: SemanticTemplate = (s) => {
    s.set(s.operand(0), 1, 8);
    s.get(s.operand(1), 16);
    s.memoryGuard(0x2000, 4, "read");
  };

  throws(
    () =>
      createActionBuilder().addInstruction(flushThenGuard, [regBinding("al"), regBinding("ax")], {
        eip: 0x1000,
        nextEip: 0x1003
      }),
    /unrestorable/
  );
});

test("add r/m32, r32 with both operands dynamic reads, then writes, in one block", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regDynamicBinding(0), regDynamicBinding(1)], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;
  const dst = v.internExternal(0);
  const src = v.internExternal(1);
  const sum = v.internBinary("add", 1, 3);
  const actions = entryActions(block);

  strictEqual(block.regions.length, 1);
  deepStrictEqual(block.values.node(dst), { kind: "external", external: 0 });
  deepStrictEqual(actions[0], {
    kind: "readState",
    output: 1,
    slot: { kind: "gprDynamic", index: dst, byteLength: 4 }
  });
  deepStrictEqual(actions[1], {
    kind: "readState",
    output: 3,
    slot: { kind: "gprDynamic", index: src, byteLength: 4 }
  });
  deepStrictEqual(actions[2], {
    kind: "writeState",
    slot: { kind: "gprDynamic", index: dst, byteLength: 4 },
    value: sum
  });

  // Flags compute from the dynamic reads exactly as from static ones.
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86ArithmeticFlags].sort());
  strictEqual(flagWriteValue(block, "ZF"), v.internCompare("eq", sum, v.internConst(0)));
});

test("a static register read keeps its order across a dynamic write", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("ebx") },
    {
      kind: "writeState",
      slot: { kind: "gprDynamic", index: v.internExternal(0), byteLength: 4 },
      value: 0
    },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
});

test("dirty GPR pendings flush before dynamic access; flags and eip ride through", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), regBinding("ecx")], {
    eip: 0x1003,
    nextEip: 0x1005
  });

  const block = builder.finish();
  const v = block.values;
  const sum = v.internBinary("add", 0, v.internConst(5));
  const actions = entryActions(block);
  const eaxFlush = actions.findIndex((a) => a.kind === "writeState" && a.slot === gprChannel("eax"));
  const dynamicWrite = actions.findIndex((a) => a.kind === "writeState" && a.slot.kind === "gprDynamic");
  const firstFlagWrite = actions.findIndex((a) => a.kind === "writeState" && a.slot.kind === "flag");

  ok(eaxFlush !== -1 && dynamicWrite !== -1, "expected an eax flush and a dynamic write");
  ok(eaxFlush < dynamicWrite, "the dirty eax pending must flush before the dynamic write");
  ok(dynamicWrite < firstFlagWrite, "flag pendings ride through and flush at the end");
  strictEqual(stateWrites(block).filter((write) => write.slot === gprChannel("eax")).length, 1);
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, sum);
  deepStrictEqual([...writtenFlags(block)].sort(), [...x86ArithmeticFlags].sort());

  const eipWrites = stateWrites(block).filter((write) => write.slot === eipChannel);

  strictEqual(eipWrites.length, 1);
  strictEqual(eipWrites[0]!.value, v.internConst(0x1005));
});

test("a dynamic write invalidates static GPR pendings for later instructions", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(movSemantic(32), [regDynamicBinding(0), immBinding(5)], {
    eip: 0x1005,
    nextEip: 0x100b
  });
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], {
    eip: 0x100b,
    nextEip: 0x100d
  });

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
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regDynamicBinding(0)], {
    eip: 0x1005,
    nextEip: 0x100b
  });
  builder.addInstruction(movSemantic(32), [regBinding("ecx"), regBinding("eax")], {
    eip: 0x100b,
    nextEip: 0x100d
  });

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
    v.internConst(0x77)
  );
});

test("pop r/mDyn flushes the incremented esp before the dynamic store, after the guard", () => {
  const builder = createActionBuilder();

  builder.addInstruction(popSemantic(), [regDynamicBinding(0)], { eip: 0x1000, nextEip: 0x1002 });

  const block = builder.finish();
  const v = block.values;
  const nextEsp = v.internBinary("add", 0, v.internConst(4));

  // Values-first: the guard (and its snapshot) precedes the esp flush the
  // dynamic store forces, so the unrestorable store happens after the last
  // fault edge.
  strictEqual(block.regions.length, 2);
  deepStrictEqual(entryActions(block), [
    { kind: "readState", output: 0, slot: gprChannel("esp") },
    { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address: 0, width: 32 },
    { kind: "writeState", slot: gprChannel("esp"), value: nextEsp },
    {
      kind: "writeState",
      slot: { kind: "gprDynamic", index: v.internExternal(0), byteLength: 4 },
      value: 2
    },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
});

test("an 8-bit template width lowers a one-byte dynamic slot", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regDynamicBinding(0)], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    {
      kind: "readState",
      output: 1,
      slot: { kind: "gprDynamic", index: v.internExternal(0), byteLength: 1 }
    },
    { kind: "writeState", slot: gprChannel("bl"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1002) },
    { kind: "exit", reason: "next" }
  ]);
});

test("a 16-bit set through a dynamic register stores a two-byte slot", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(16), [regDynamicBinding(0), immBinding(0x1234)], {
    eip: 0x1000,
    nextEip: 0x1004
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], {
    kind: "writeState",
    slot: { kind: "gprDynamic", index: v.internExternal(0), byteLength: 2 },
    value: v.internConst(0x1234)
  });
});

test("movsx r32, r8 from a dynamic register marks the read signed with no extra extend", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), regDynamicBinding(0)], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block)[0], {
    kind: "readState",
    output: 1,
    slot: { kind: "gprDynamic", index: v.internExternal(0), byteLength: 1 },
    signed: true
  });
  strictEqual(stateWrites(block).find((write) => write.slot === gprChannel("eax"))?.value, 1);
  ok(!nodeKinds(block).includes("unary"), "no extends expected");
});

test("a guard after a dynamic flush of an instruction-written register fails loudly", () => {
  const setThenDynamicRead: SemanticTemplate = (s) => {
    s.set(s.reg("ebx"), 0x111, 32);
    s.get(s.operand(0), 32);
    s.memoryGuard(0x2000, 4, "read");
  };

  throws(
    () =>
      createActionBuilder().addInstruction(setThenDynamicRead, [regDynamicBinding(0)], {
        eip: 0x1000,
        nextEip: 0x1002
      }),
    /unrestorable/
  );
});

test("a guard after a dynamic write fails loudly", () => {
  const dynamicWriteThenGuard: SemanticTemplate = (s) => {
    s.set(s.operand(0), 0x222, 32);
    s.memoryGuard(0x2000, 4, "write");
  };

  throws(
    () =>
      createActionBuilder().addInstruction(dynamicWriteThenGuard, [regDynamicBinding(0)], {
        eip: 0x1000,
        nextEip: 0x1002
      }),
    /unrestorable/
  );
});

test("an external location flushes eip as the nextEip external", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(5)], {
    eip: { external: 0 },
    nextEip: { external: 1 }
  });

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(entryActions(block), [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(5) },
    { kind: "writeState", slot: eipChannel, value: v.internExternal(1) },
    { kind: "exit", reason: "next" }
  ]);
});

test("a fault edge restores an external eip", () => {
  const builder = createActionBuilder();

  builder.addInstruction(
    movSemantic(32),
    [regBinding("eax"), memBinding({ scale: 1, disp: 0x2000 })],
    { eip: { external: 4 }, nextEip: { external: 5 } }
  );

  const block = builder.finish();
  const v = block.values;

  deepStrictEqual(edgeRegion(block, 1).flushes, [
    { kind: "writeState", slot: eipChannel, value: v.internExternal(4) }
  ]);
  deepStrictEqual(edgeRegion(block, 1).exit, {
    kind: "exit",
    reason: "memoryReadFault",
    payload: v.internConst(0x2000)
  });
  strictEqual(
    stateWrites(block).find((write) => write.slot === eipChannel)?.value,
    v.internExternal(5)
  );
});

test("a memExternal operand guards and accesses the external address", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), memExternalBinding(7)], {
    eip: 0x1000,
    nextEip: 0x1006
  });

  const block = builder.finish();
  const v = block.values;
  const address = v.internExternal(7);

  deepStrictEqual(entryActions(block), [
    { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 1 },
    { kind: "readMemory", output: 2, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: 2 },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1006) },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(edgeRegion(block, 1).exit, {
    kind: "exit",
    reason: "memoryReadFault",
    payload: address
  });
});

test("a narrow immExternal get projects to the access width", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), immExternalBinding(0)], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.slot === gprChannel("bl"));

  deepStrictEqual(v.node(write!.value), {
    kind: "project",
    width: 8,
    value: v.internExternal(0)
  });
});

test("a signed immExternal get sign-extends instead of masking", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("eax"), immExternalBinding(0)], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();
  const v = block.values;
  const write = stateWrites(block).find((entry) => entry.slot === gprChannel("eax"));

  deepStrictEqual(v.node(write!.value), {
    kind: "unary",
    operator: "extend8_s",
    value: v.internExternal(0)
  });
});

function instructionCountRead(block: ActionBlock): ReadStateAction {
  const read = rawEntryActions(block).find(
    (action): action is ReadStateAction =>
      action.kind === "readState" && action.slot === instructionCountChannel
  );

  ok(read !== undefined, "expected an instruction-count read");
  return read;
}

test("every instruction advances the count channel once, flushed once", () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], { eip: 0x1000, nextEip: 0x1005 });
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(9)], { eip: 0x1005, nextEip: 0x100a });

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
      value: v.internBinary("add", instructionCountRead(block).output, v.internConst(2))
    }
  ]);
});

test("branch edges flush the advanced count", () => {
  const builder = createActionBuilder();

  builder.addInstruction(jccSemantic("E"), [immBinding(0x2000)], { eip: 0x1000, nextEip: 0x1002 });

  const block = builder.finish();
  const v = block.values;
  const advanced = v.internBinary("add", instructionCountRead(block).output, v.internConst(1));

  for (const index of [1, 2]) {
    strictEqual(
      edgeRegion(block, index).flushes.find((flush) => flush.slot === instructionCountChannel)?.value,
      advanced
    );
  }
});

test("a fault edge restores the boundary count", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("eax"), immBinding(0x77)], {
    eip: 0x1000,
    nextEip: 0x1005
  });
  builder.addInstruction(
    movSemantic(32),
    [memBinding({ base: "ebx", scale: 1, disp: 0 }), regBinding("eax")],
    { eip: 0x1005, nextEip: 0x1007 }
  );

  const block = builder.finish();
  const v = block.values;

  // The faulting store's own advance never reaches the edge: it restores the
  // first instruction's count.
  strictEqual(
    edgeRegion(block, 1).flushes.find((flush) => flush.slot === instructionCountChannel)?.value,
    v.internBinary("add", instructionCountRead(block).output, v.internConst(1))
  );
});

test("a host trap flushes the advanced count", () => {
  const builder = createActionBuilder();

  builder.addInstruction(intSemantic(), [immBinding(0x21)], { eip: 0x1000, nextEip: 0x1002 });

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
      value: v.internBinary("add", instructionCountRead(block).output, v.internConst(1))
    }
  ]);
});
