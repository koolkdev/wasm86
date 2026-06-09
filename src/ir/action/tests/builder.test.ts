import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { createActionBuilder } from "#ir/action/builder.js";
import { immBinding, regBinding } from "#ir/action/operands.js";
import { eipChannel, gprChannel } from "#ir/action/slots.js";
import { aluSemantic } from "#x86/semantics/alu.js";
import { movSemantic } from "#x86/semantics/mov.js";

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

test("unsupported templates fail loudly", () => {
  throws(
    () =>
      createActionBuilder().addInstruction(
        aluSemantic("add", 32),
        [regBinding("eax"), immBinding(1)],
        { eip: 0x1000, nextEip: 0x1005 }
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
