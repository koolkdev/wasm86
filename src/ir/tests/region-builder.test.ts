import {
  deepStrictEqual,
  doesNotThrow,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import {
  resourceRef,
  type ResourceByteOperand
} from "#compiler/ir/resource.js";
import { RegionBuilder, buildIrBlock, type BodyActionSink } from "#ir/region-builder.js";
import { validateIrBlock } from "#ir/validate.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/program/refs.js";
import {
  compilerTestResourceEffect,
  resourceReadAction,
  resourceWriteAction
} from "#ir/tests/storage-op-helpers.js";

function readOperation(values: ValueTable, region = 0) {
  return resourceRead.create({
    source: {
      effect: compilerTestResourceEffect(region),
      address: { base: values.const(0), displacement: region * 4 },
      width: 32
    }
  });
}

function writeOperation(values: ValueTable, value: ValueId, region = 0) {
  return resourceWrite.create({
    destination: {
      effect: compilerTestResourceEffect(region),
      address: { base: values.const(0), displacement: region * 4 },
      width: 32
    },
    value
  });
}

function testCallTarget(id: string): FunctionDefinition {
  return new FunctionDefinition({
    ref: functionRef(id),
    type: functionType(["i32", "i32", "i32", "i32"], ["i32"]),
    effects: { reads: [], writes: [] },
    owner: undefined,
    build: () => {}
  });
}

test("operation derives the output and its bounds from the definition", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const resource = resourceRef("test.region-builder-resource");
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

test("resource read modes reach operation construction", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const resource = resourceRef("test.region-builder-refined-resource");
  const source: ResourceByteOperand = {
    effect: {
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 1 }
      }
    },
    address: { base: values.const(0), displacement: 0 },
    width: 8
  };

  const signed = builder.operation(resourceRead.create({
    source,
    mode: { kind: "signed" }
  }));
  const bounded = builder.operation(resourceRead.create({
    source,
    mode: {
      kind: "unsigned",
      bounds: fitsUnsigned(1)
    }
  }));

  const [signedAction, boundedAction] = builder.build().actions;

  ok(signedAction?.kind === "op" && signedAction.op.kind === "resource.read");
  ok(boundedAction?.kind === "op" && boundedAction.op.kind === "resource.read");
  strictEqual(signedAction.op.signed, true);
  strictEqual(boundedAction.op.signed, undefined);
  deepStrictEqual(values.widthBounds(signed), signExtended(8));
  deepStrictEqual(values.widthBounds(bounded), fitsUnsigned(1));
});

test("one operation API handles value and effect definitions", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const value = values.const(0);

  strictEqual(builder.operation(writeOperation(values, value)), undefined);
  strictEqual(builder.operation(readOperation(values)), value + 1);
});

test("call validates typed arguments and allocates its declared result", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const target = testCallTarget("test.region-builder.call-target");
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  const [output] = builder.call(target, args);

  ok(output !== undefined, "expected status-flag call result");
  deepStrictEqual(builder.build(), {
    actions: [{
      kind: "call",
      target,
      arguments: args.map((value) => ({ value, type: "i32" as const })),
      outputs: [output]
    }]
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
  const builder = new RegionBuilder(values);
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
  const builder = new RegionBuilder(values);
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
  const source = new RegionBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const sourceActions = source.build().actions;
  const target = new RegionBuilder(values);

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
  const source = new RegionBuilder(values);
  const cell = source.cell(values.const(1));

  source.read(cell);

  const target = new RegionBuilder(values);

  target.extend(source.build().actions);
  target.finish({ kind: "dispatch", targetEip: values.const(0) });

  doesNotThrow(() => validateIrBlock({ values, body: target.build() }));
});

test("effect, push, and extend append actions without outputs", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const prebuilt = resourceWriteAction(values, 0, values.const(4));
  const other = resourceWriteAction(values, 0, values.const(8));

  builder.operation(writeOperation(values, values.const(0)));
  builder.push(prebuilt);
  builder.extend([other]);
  deepStrictEqual(builder.build(), {
    actions: [resourceWriteAction(values, 0, values.const(0)), prebuilt, other]
  });
});

test("custom action sinks can divert emitted top-level actions", () => {
  const values = new ValueTable();
  const sink = new class implements BodyActionSink {
    readonly bodyActions: Action[] = [];
    readonly diverted: Action[] = [];

    push(action: Action): void {
      if (action.kind === "op" && action.op.kind === "resource.read") {
        this.diverted.push(action);
        return;
      }

      this.bodyActions.push(action);
    }

    actions(): readonly Action[] {
      return this.bodyActions;
    }
  }();
  const builder = new RegionBuilder(values, sink);
  const read = builder.operation(readOperation(values));

  builder.operation(writeOperation(values, values.const(4)));

  deepStrictEqual(sink.diverted, [resourceReadAction(values, read, 0)]);
  deepStrictEqual(builder.build(), {
    actions: [resourceWriteAction(values, 0, values.const(4))]
  });
});

test("if builds hinted then and else bodies against child builders", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const condition = values.external(0);
  const exitResult = values.const64(0n);

  builder.if(
    condition,
    (then) => then.operation(
      writeOperation(then.values, then.values.const(4))
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
        thenBody: { actions: [resourceWriteAction(values, 0, values.const(4))] },
        elseBody: {
          actions: [{ kind: "finish", finish: { kind: "exit", result: exitResult } }]
        }
      }
    ]
  });
});

test("switch builds every arm before allocating the shared output", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const selector = values.external(0);
  const args = [values.const(0), values.const(1), values.const(2), values.const(3)] as const;
  const target = testCallTarget("test.region-builder.switch-call-target");
  let armResult!: ValueId;
  let defaultResult!: ValueId;
  const output = builder.switch(
    selector,
    [{
      match: 3,
      build: (arm) => {
        const [result] = arm.call(target, args);

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
            actions: [{
              kind: "call",
              target,
              arguments: args.map((value) => ({ value, type: "i32" as const })),
              outputs: [armResult]
            }],
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
  const builder = new RegionBuilder(values);
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

    b.loop([{ seed: b.values.const(3), loopInput: input }], (body) => {
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
    (b) => (eip = b.operation(readOperation(b.values)))
  );

  strictEqual(block.body.result, eip);
});

test("buildIrBlock leaves the root result unset for void callbacks", () => {
  const block = buildIrBlock((b) => {
    b.operation(writeOperation(b.values, b.values.const(0)));
  });

  strictEqual(block.body.result, undefined);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});
