import {
  deepStrictEqual,
  doesNotThrow,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceByteOperand
} from "#compiler/ir/resource.js";
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
import { statusFlagResolvers } from "#core/flags/resolvers.js";
import { stateRead, stateWrite, statusFlagCall } from "#ir/tests/storage-op-helpers.js";

test("operation derives the output and its bounds from the definition", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const resource = resourceRef("test.body-builder-resource");
  const address = values.const(0);
  const source: ResourceByteOperand = {
    effect: {
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 1 }
      }
    },
    address: { base: address, displacement: 0 },
    width: 8
  };
  const read = builder.operation(resourceRead.create({
    source
  }));

  deepStrictEqual(builder.build(), {
    actions: [{
      kind: "op",
      output: read,
      op: resourceRead.create({
        source
      })
    }]
  });
  deepStrictEqual(values.widthBounds(read), fitsUnsigned(8));
});

test("one operation API handles value and effect definitions", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const value = values.const(0);

  strictEqual(builder.operation(stateWriteOperation.create({ slot: eipChannel, value })), undefined);
  strictEqual(builder.operation(stateReadOperation.create({ slot: eipChannel })), value + 1);
});

test("call validates typed arguments and allocates its declared result", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const target = statusFlagResolvers.get("ZF");
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  const [output] = builder.call(target, args);

  ok(output !== undefined, "expected status-flag call result");
  deepStrictEqual(builder.build(), {
    actions: [statusFlagCall(output, "ZF", ...args)]
  });
  deepStrictEqual(values.node(output), { kind: "actionOutput", type: "i32" });
  throws(() => builder.call(target, args.slice(1)), /expects 4 arguments, got 3/);
  throws(
    () => builder.call(target, [args[0]!, args[1]!, args[2]!, values.const64(3n)]),
    /argument 3 must be i32, got i64/
  );
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
  const exitResult = values.const64(0n);

  builder.if(
    condition,
    (then) => then.operation(
      stateWriteOperation.create({ slot: eipChannel, value: then.values.const(4) })
    ),
    {
      hint: "unlikely",
      elseBuild: (other) => other.finish({ kind: "exit", result: exitResult })
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
          actions: [{ kind: "finish", finish: { kind: "exit", result: exitResult } }]
        }
      }
    ]
  });
});

test("switch builds every arm before allocating the shared output", () => {
  const values = new ValueTable();
  const builder = new BodyBuilder(values);
  const selector = values.external(0);
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  let armResult!: ValueId;
  let defaultResult!: ValueId;
  const output = builder.switch(
    selector,
    [{
      match: 3,
      build: (arm) => {
        const [result] = arm.call(statusFlagResolvers.get("ZF"), args);

        ok(result !== undefined, "expected call result");
        return (armResult = result);
      }
    }],
    (arm) => (defaultResult = arm.values.const(1))
  );

  ok(armResult < output);
  ok(defaultResult < output);
  deepStrictEqual(values.widthBounds(output), { unsignedBits: 32, signedBits: 32 });
  deepStrictEqual(builder.build(), {
    actions: [
      {
        kind: "switch",
        selector,
        output,
        cases: [{
          match: 3,
          body: {
            actions: [statusFlagCall(armResult, "ZF", ...args)],
            result: armResult
          }
        }],
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
    b.finish({ kind: "exit", result: b.values.const64(0n) });
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
