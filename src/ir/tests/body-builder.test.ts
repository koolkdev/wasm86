import {
  deepStrictEqual,
  doesNotThrow,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { memoryCheck as memoryCheckOperation } from "#compiler/ir/operations/memory.js";
import { resolveFlag as resolveFlagOperation } from "#compiler/ir/operations/resolve-flag.js";
import {
  stateRead as stateReadOperation,
  stateWrite as stateWriteOperation
} from "#compiler/ir/operations/state.js";
import { BodyBuilder, buildIrBlock, type BodyActionSink } from "#ir/body-builder.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import { validateIrBlock } from "#ir/validate.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { memoryCheck, resolveFlag, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

test("operation derives the output and its bounds from the definition", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const address = values.const(0x1000);
  const byteLength = values.const(4);
  const fault = builder.operation(memoryCheckOperation.create({ address, byteLength }));

  deepStrictEqual(builder.build(), { actions: [memoryCheck(fault, address, byteLength)] });
  deepStrictEqual(values.widthBounds(fault), fitsUnsigned(1));
});

test("one operation API handles value and effect definitions", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const value = values.const(0);

  strictEqual(builder.operation(stateWriteOperation.create({ slot: eipChannel, value })), undefined);
  strictEqual(builder.operation(stateReadOperation.create({ slot: eipChannel })), value + 1);
});

test("cell APIs seed typed cells and preserve lexical access in child bodies", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const seed = values.const64(7n);
  const cell = builder.cell(seed);
  let read!: ValueId;

  builder.if(values.external(0), (child) => {
    child.write(cell, child.values.const64(8n));
    read = child.read(cell);
  });
  builder.finish({ kind: "dispatch", targetEip: values.const(0) });

  const block = { values, body: builder.build() };
  const seedAction = block.body.actions[0];
  const branch = block.body.actions[1];

  strictEqual(cell.type, "i64");
  strictEqual(values.valueType(read), "i64");
  ok(seedAction?.kind === "op" && seedAction.op.kind === "cell.write");
  strictEqual(seedAction.op.initialization, "seed");
  ok(branch?.kind === "if");
  strictEqual(branch.thenBody.actions[0]?.kind, "op");
  strictEqual(branch.thenBody.actions[1]?.kind, "op");
  doesNotThrow(() => validateIrBlock(block));
});

test("validation rejects writes whose value type differs from the cell", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const cell = builder.cell(values.const(1));

  builder.write(cell, values.const64(2n));
  builder.finish({ kind: "dispatch", targetEip: values.const(0) });

  throws(
    () => validateIrBlock({ values, body: builder.build() }),
    /operand .* must be i32, got i64/
  );
});

test("validation rejects a cell access transplanted away from its seed", () => {
  const values = new ValueTable();
  const source = new BodyBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const sourceActions = source.build().actions;
  const target = new BodyBuilder(values);

  // Moving only the read leaves its declaring seed behind in another tree.
  target.push(sourceActions[1]!);
  target.finish({ kind: "dispatch", targetEip: values.const(0) });

  throws(
    () => validateIrBlock({ values, body: target.build() }),
    /uses a cell with no seed in this root/
  );
});

test("a transplanted seed carries its cell's scope with it", () => {
  // Scope is where the seed is: relocating the whole seed+use sequence into
  // another root is structurally sound, with no stale metadata to desync.
  const values = new ValueTable();
  const source = new BodyBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const target = new BodyBuilder(values);

  target.extend(source.build().actions);
  target.finish({ kind: "dispatch", targetEip: values.const(0) });

  doesNotThrow(() => validateIrBlock({ values, body: target.build() }));
});

test("effect, push, and extend append actions without outputs", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const prebuilt = stateWrite(eipChannel, values.const(4));
  const other = stateWrite(eipChannel, values.const(8));

  builder.operation(stateWriteOperation.create({ slot: eipChannel, value: values.const(0) }));
  builder.push(prebuilt);
  builder.extend([other]);
  deepStrictEqual(builder.build(), {
    actions: [stateWrite(eipChannel, values.const(0)), prebuilt, other]
  });
});

test("custom action sinks can divert emitted top-level actions", () => {
  const values = new ValueTable();
  const sink = new class implements BodyActionSink {
    readonly bodyActions: Action[] = [];
    readonly diverted: Action[] = [];

    push(action: Action): void {
      if (action.kind === "op" && action.op.kind === "state.read") {
        this.diverted.push(action);
        return;
      }

      this.bodyActions.push(action);
    }

    actions(): readonly Action[] {
      return this.bodyActions;
    }
  }();
  const builder = new BodyBuilder(values, sink);
  const read = builder.operation(stateReadOperation.create({ slot: eipChannel }));

  builder.operation(stateWriteOperation.create({ slot: eipChannel, value: values.const(4) }));

  deepStrictEqual(sink.diverted, [stateRead(read, eipChannel)]);
  deepStrictEqual(builder.build(), {
    actions: [stateWrite(eipChannel, values.const(4))]
  });
});

test("if builds hinted then and else bodies against child builders", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const condition = values.external(0);

  builder.if(
    condition,
    (then) => then.operation(
      stateWriteOperation.create({ slot: eipChannel, value: then.values.const(4) })
    ),
    {
      hint: "unlikely",
      elseBuild: (other) => other.finish({ kind: "exit", exit: { class: "host", reason: "unsupported" } })
    }
  );
  deepStrictEqual(builder.build(), {
    actions: [
      {
        kind: "if",
        condition,
        hint: "unlikely",
        thenBody: { actions: [stateWrite(eipChannel, values.const(4))] },
        elseBody: {
          actions: [{ kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "unsupported" } } }]
        }
      }
    ]
  });
});

test("switch builds every arm before allocating the shared output", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const selector = values.external(0);
  let armResult!: ValueId;
  let defaultResult!: ValueId;
  const output = builder.switch(
    selector,
    [{
      match: 3,
      build: (arm) => (armResult = arm.operation(resolveFlagOperation.create({ flag: "ZF" })))
    }],
    (arm) => (defaultResult = arm.values.const(1))
  );

  ok(armResult < output);
  ok(defaultResult < output);
  deepStrictEqual(values.widthBounds(output), fitsUnsigned(1));
  deepStrictEqual(builder.build(), {
    actions: [
      {
        kind: "switch",
        selector,
        output,
        cases: [{ match: 3, body: { actions: [resolveFlag(armResult, "ZF")], result: armResult } }],
        defaultBody: { actions: [], result: defaultResult }
      }
    ]
  });
});

test("switch derives its output bounds from reachable arms", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const output = builder.switch(
    values.external(0),
    [{ match: 0, build: (arm) => arm.values.unreachable() }],
    (arm) => arm.values.const(0)
  );

  deepStrictEqual(values.widthBounds(output), { unsignedBits: 1, signedBits: 1 });
});

test("loop bodies take the back edge through loopContinue and validate", () => {
  const block = buildIrBlock((b) => {
    const input = b.values.addLoopInput();

    b.loop([{ channel: gprChannel("ecx"), seed: b.values.const(3), loopInput: input }], (body) => {
      const next = body.values.binary("sub", input, body.values.const(1));

      body.if(body.values.compare(32, "ne", next, body.values.const(0)), (taken) => taken.loopContinue([next]));
    });
    b.finish({ kind: "exit", exit: { class: "host", reason: "unsupported" } });
  });

  doesNotThrow(() => validateIrBlock(block));
});

test("buildIrBlock forwards a returned value as the root body result", () => {
  let eip!: ValueId;
  const block = buildIrBlock(
    (b) => (eip = b.operation(stateReadOperation.create({ slot: eipChannel })))
  );

  strictEqual(block.body.result, eip);
});

test("buildIrBlock leaves the root result unset for void callbacks", () => {
  const block = buildIrBlock((b) => {
    b.operation(stateWriteOperation.create({ slot: eipChannel, value: b.values.const(0) }));
  });

  strictEqual(block.body.result, undefined);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});
