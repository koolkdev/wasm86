import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, regBinding } from "#ir/action/operands.js";
import { eipChannel, flagChannel, gprChannel } from "#ir/action/slots.js";
import type { ActionBlock, WriteStateAction } from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";
import type { FlagName } from "#ir/model/flags.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { aluSemantic, unaryAluSemantic } from "#x86/semantics/alu.js";
import { cmpSemantic } from "#x86/semantics/cmp.js";
import { movSemantic } from "#x86/semantics/mov.js";
import { setccSemantic } from "#x86/semantics/setcc.js";
import { xchgSemantic } from "#x86/semantics/xchg.js";

function stateWrites(block: ActionBlock): WriteStateAction[] {
  return block.regions[0]!.actions.filter(
    (action): action is WriteStateAction => action.kind === "writeState"
  );
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

  // Spot-check through re-interning: ZF compares the projected sum against
  // zero, and the register write shares the same sum node.
  const v = block.values;
  const sum = v.internProject(
    32,
    v.internBinary("add", v.internProject(32, 0), v.internProject(32, v.internConst(5)))
  );

  strictEqual(flagWriteValue(block, "ZF"), v.internCompare(32, "eq", sum, v.internConst(0)));
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
  const sum1 = v.internProject(
    32,
    v.internBinary("add", v.internProject(32, 0), v.internProject(32, v.internConst(5)))
  );
  const sum2 = v.internProject(
    32,
    v.internBinary("add", v.internProject(32, sum1), v.internProject(32, v.internConst(7)))
  );

  strictEqual(writes.find((write) => write.slot === gprChannel("eax"))?.value, sum2);
  strictEqual(flagWriteValue(block, "ZF"), v.internCompare(32, "eq", sum2, v.internConst(0)));
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
  const a = v.internProject(32, 0);
  const b = v.internProject(32, v.internConst(5));
  const result = v.internProject(32, v.internBinary("add", a, b));
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
  deepStrictEqual(block.values.node(2), { kind: "compare", width: 32, operator: "lt_s", a: 0, b: 1 });
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

test("unsupported operand bindings and widths fail loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(
        movSemantic(32),
        [regBinding("eax"), { kind: "mem", address: { scale: 1, disp: 0x2000 } }],
        { eip: 0x1000, nextEip: 0x1006 }
      ),
    /not supported by action builder yet/
  );

  throws(
    () =>
      createActionBuilder().addInstruction(
        movSemantic(8),
        [regBinding("al"), immBinding(1)],
        { eip: 0x1000, nextEip: 0x1002 }
      ),
    /not supported by action builder yet/
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
