import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, regBinding } from "#ir/action/operands.js";
import { eipChannel, flagChannel, gprChannel } from "#ir/action/slots.js";
import type { ActionBlock, WriteStateAction } from "#ir/action/types.js";
import type { ValueId, ValueNode } from "#ir/action/values.js";
import type { FlagName } from "#ir/model/flags.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { movSemantic, movsxSemantic, movzxSemantic } from "#x86/semantics/mov.js";
import { setccSemantic } from "#x86/semantics/setcc.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";

function stateWrites(block: ActionBlock): WriteStateAction[] {
  return block.regions[0]!.actions.filter(
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

  strictEqual(block.regions.length, 1);

  const entry = block.regions[0]!;

  strictEqual(entry.id, block.entry);
  strictEqual(entry.kind, "entry");
  deepStrictEqual(entry.actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 1 },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(block.values.node(0), { kind: "const", value: 0x12345678 });
  deepStrictEqual(block.values.node(1), { kind: "const", value: 0x401005 });
  strictEqual(block.values.size(), 2);
});

test("pending writes overwrite per channel and consts intern across instructions", () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("eax"), immBinding(7)], { eip: 0x1000, nextEip: 0x1005 });
  builder.addInstruction(mov, [regBinding("ecx"), immBinding(7)], { eip: 0x1005, nextEip: 0x100a });
  builder.addInstruction(mov, [regBinding("eax"), immBinding(9)], { eip: 0x100a, nextEip: 0x100f });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: block.values.internConst(9) },
    { kind: "writeState", slot: eipChannel, value: block.values.internConst(0x100f) },
    { kind: "writeState", slot: gprChannel("ecx"), value: block.values.internConst(7) },
    { kind: "exit", reason: "next" }
  ]);

  // Exactly 7, 0x1005, 0x100a, 9, 0x100f — both movs of 7 share one const.
  strictEqual(block.values.size(), 5);
});

test("mov r32, r32 records one readState and forwards its leaf", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(32), [regBinding("ebx"), regBinding("eax")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 1 },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(block.values.node(0), { kind: "actionOutput" });
  strictEqual(block.values.size(), 2);
});

test("repeated get of an unwritten channel returns the same leaf across instructions", () => {
  const builder = createActionBuilder();
  const mov = movSemantic(32);

  builder.addInstruction(mov, [regBinding("ebx"), regBinding("eax")], { eip: 0x1000, nextEip: 0x1002 });
  builder.addInstruction(mov, [regBinding("ecx"), regBinding("eax")], { eip: 0x1002, nextEip: 0x1004 });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 2 },
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
  const actions = block.regions[0]!.actions;
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

test("flagUndef cells produce no write: xor leaves AF unwritten", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("xor", 32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual([...writtenFlags(block)].sort(), ["CF", "OF", "PF", "SF", "ZF"]);
});

test("an undef cell preserves the previous instruction's pending flag", () => {
  const builder = createActionBuilder();

  builder.addInstruction(aluSemantic("add", 32), [regBinding("eax"), immBinding(5)], {
    eip: 0x1000,
    nextEip: 0x1003
  });
  builder.addInstruction(aluSemantic("xor", 32), [regBinding("ecx"), regBinding("edx")], {
    eip: 0x1003,
    nextEip: 0x1005
  });

  const block = builder.finish();

  // xor leaves AF undefined, so the add's AF expression survives and flushes.
  const v = block.values;
  const a = 0; // the eax readState leaf
  const b = v.internConst(5);
  const result = v.internBinary("add", a, b);
  const carryChain = v.internBinary("xor", v.internBinary("xor", a, b), result);
  const af = v.internBinary("and", v.internBinary("shr_u", carryChain, v.internConst(4)), v.internConst(1));

  strictEqual(flagWriteValue(block, "AF"), af);

  // xor's constant-zero CF/OF writes win over the add's expressions.
  strictEqual(flagWriteValue(block, "CF"), v.internConst(0));
  strictEqual(flagWriteValue(block, "OF"), v.internConst(0));
});

test("xchg eax, ebx swaps pendings through two reads with no temporaries", () => {
  const builder = createActionBuilder();

  builder.addInstruction(xchgSemantic(32), [regBinding("eax"), regBinding("ebx")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "readState", output: 1, slot: gprChannel("ebx") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: gprChannel("eax"), value: 1 },
    { kind: "writeState", slot: eipChannel, value: 2 },
    { kind: "exit", reason: "next" }
  ]);

  // Two read leaves plus the eip constant — nothing else was created.
  strictEqual(block.values.size(), 3);
});

test("mov r8, r8 reads and writes byte channels with no bit algebra", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movSemantic(8), [regBinding("bl"), regBinding("ah")], {
    eip: 0x1000,
    nextEip: 0x1002
  });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("ah") },
    { kind: "writeState", slot: gprChannel("bl"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 1 },
    { kind: "exit", reason: "next" }
  ]);
  // The read leaf and the eip constant — no masks or shifts were created.
  strictEqual(block.values.size(), 2);
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

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "writeState", slot: gprChannel("al"), value: v.internConst(0x12) },
    { kind: "readState", output: 2, slot: gprChannel("eax") },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1004) },
    { kind: "writeState", slot: gprChannel("ebx"), value: 2 },
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

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "writeState", slot: gprChannel("eax"), value: v.internConst(0x12345678) },
    { kind: "readState", output: 2, slot: gprChannel("al") },
    { kind: "writeState", slot: eipChannel, value: v.internConst(0x1007) },
    { kind: "writeState", slot: gprChannel("bl"), value: 2 },
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

  deepStrictEqual(block.regions[0]!.actions, [
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
  const actions = block.regions[0]!.actions;

  strictEqual(actions[0]!.kind, "writeState");
  deepStrictEqual(actions[1], { kind: "readState", output: 2, slot: gprChannel("ah") });
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
  const actions = block.regions[0]!.actions;
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

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("al") },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 1 },
    { kind: "exit", reason: "next" }
  ]);
  strictEqual(block.values.size(), 2);
});

test("movsx r32, r8 marks the read for a sign-extending load", () => {
  const builder = createActionBuilder();

  builder.addInstruction(movsxSemantic(8, 32), [regBinding("ebx"), regBinding("al")], {
    eip: 0x1000,
    nextEip: 0x1003
  });

  const block = builder.finish();

  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("al"), signed: true },
    { kind: "writeState", slot: gprChannel("ebx"), value: 0 },
    { kind: "writeState", slot: eipChannel, value: 1 },
    { kind: "exit", reason: "next" }
  ]);
  strictEqual(block.values.size(), 2);
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
  const actions = block.regions[0]!.actions;

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

  // 0: eax leaf, 1: 0, 2: compare, 3: sub(0 - leaf), 4: select, 5: 0x1003.
  deepStrictEqual(block.regions[0]!.actions, [
    { kind: "readState", output: 0, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: 4 },
    { kind: "writeState", slot: eipChannel, value: 5 },
    { kind: "exit", reason: "next" }
  ]);
  deepStrictEqual(block.values.node(2), { kind: "compare", operator: "lt_s", a: 0, b: 1 });
  deepStrictEqual(block.values.node(3), { kind: "binary", operator: "sub", a: 1, b: 0 });
  deepStrictEqual(block.values.node(4), { kind: "select", condition: 2, whenTrue: 3, whenFalse: 0 });
});

test("unsupported templates fail loudly", () => {
  // condition() consumption lands in 04b; setcc still rejects.
  throws(
    () =>
      createActionBuilder().addInstruction(
        setccSemantic("E"),
        [regBinding("al")],
        { eip: 0x1000, nextEip: 0x1003 }
      ),
    /not supported by action builder yet/
  );
});

test("unsupported operand bindings fail loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(
        movSemantic(32),
        [regBinding("eax"), { kind: "mem", address: { scale: 1, disp: 0x2000 } }],
        { eip: 0x1000, nextEip: 0x1006 }
      ),
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
  const setThenTrap: Parameters<typeof builder.addInstruction>[0] = (s) => {
    s.set(s.operand(0), 1, 32);
    s.hostTrap(0);
  };

  throws(
    () =>
      builder.addInstruction(setThenTrap, [regBinding("eax")], { eip: 0x1000, nextEip: 0x1002 }),
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
