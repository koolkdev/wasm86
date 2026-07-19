import {
  deepStrictEqual,
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { CellRef } from "#compiler/refs/cell.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { placeBody } from "#compiler/placement/place.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import type { OpAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import {
  compilerTestValues,
  resourceReadAction,
  resourceWriteAction
} from "#ir/tests/storage-op-helpers.js";

function write(
  cell: CellRef,
  value: ValueId,
  initialization: "seed" | "update"
): OpAction {
  return {
    kind: "op",
    op: cellWrite.create({ cell, value, initialization })
  };
}

function read(cell: CellRef, output: ValueId): OpAction {
  return {
    kind: "op",
    output,
    op: cellRead.create({ cell })
  };
}

function place(block: IrBlock, exports: readonly ValueId[] = []) {
  return placeBody(block, {
    exportedOutputs: exports,
    allowImplicitEntryFallthrough: true
  });
}

test("a referenced cell receives one typed local", () => {
  const values = compilerTestValues();
  const cell = new CellRef("i32");
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(cell, values.const(7), "seed"),
        read(cell, output),
        resourceWriteAction(values, 0, output)
      ]
    }
  };
  const { plan } = place(block);
  const local = plan.cellLocals.get(cell);

  strictEqual(local, 0);
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("cell locals are allocated when a cell has only writes", () => {
  const values = compilerTestValues();
  const cell = new CellRef("i32");
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(cell, values.const(0), "seed"),
        write(cell, values.const(1), "update")
      ]
    }
  };
  const { plan } = place(block);

  strictEqual(plan.cellLocals.size, 1);
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("distinct cells receive distinct locals with their scalar types", () => {
  const values = compilerTestValues();
  const narrow = new CellRef("i32");
  const wide = new CellRef("i64");
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(narrow, values.const(1), "seed"),
        write(wide, values.const64(2n), "seed")
      ]
    }
  };
  const { plan } = place(block);
  const narrowLocal = plan.cellLocals.get(narrow);
  const wideLocal = plan.cellLocals.get(wide);

  ok(narrowLocal !== undefined);
  ok(wideLocal !== undefined);
  strictEqual(narrowLocal === wideLocal, false);
  strictEqual(plan.localTypes[narrowLocal], "i32");
  strictEqual(plan.localTypes[wideLocal], "i64");
});

test("nested branch and loop accesses share the declaring cell's local", () => {
  const values = compilerTestValues();
  const cell = new CellRef("i32");
  const output = values.addActionOutput();
  const loopBody: Body = {
    actions: [
      write(cell, values.const(3), "update"),
      read(cell, output),
      resourceWriteAction(values, 0, output)
    ]
  };
  const thenBody: Body = {
    actions: [{ kind: "loop", carried: [], body: loopBody }]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(cell, values.const(1), "seed"),
        { kind: "if", condition: values.external(0), thenBody }
      ]
    }
  };
  const { plan } = place(block);

  strictEqual(plan.cellLocals.size, 1);
  strictEqual(plan.cellLocals.has(cell), true);
});

test("a cell never shares a local with an overlapping value temporary", () => {
  const values = compilerTestValues();
  const cell = new CellRef("i32");
  const snapshot = values.addActionOutput();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceReadAction(values, snapshot, 0),
        resourceWriteAction(values, 0, values.const(9)),
        write(cell, values.const(1), "seed"),
        read(cell, output),
        resourceWriteAction(values, 1, snapshot),
        resourceWriteAction(values, 2, output)
      ]
    }
  };
  const { analysis, plan } = place(block);
  const valuePlacement = plan.values[snapshot];
  const cellLocal = plan.cellLocals.get(cell);

  strictEqual(valuePlacement?.kind, "capture");
  ok(cellLocal !== undefined);
  if (valuePlacement?.kind !== "capture") {
    throw new Error("snapshot did not receive a value local");
  }
  strictEqual(cellLocal === valuePlacement.local, false);

  throws(
    () => validatePlacement(block, analysis, { ...plan, cellLocals: new Map() }),
    /referenced cell has no local/
  );
  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      cellLocals: new Map([[cell, valuePlacement.local]])
    }),
    /overlap in local/
  );
});

test("placement validation rejects overlapping, mistyped, and stale cell locals", () => {
  const values = compilerTestValues();
  const first = new CellRef("i32");
  const second = new CellRef("i32");
  const firstOut = values.addActionOutput();
  const secondOut = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(first, values.const(1), "seed"),
        write(second, values.const(2), "seed"),
        read(first, firstOut),
        read(second, secondOut),
        resourceWriteAction(values, 0, firstOut),
        resourceWriteAction(values, 1, secondOut)
      ]
    }
  };
  const { analysis, plan } = place(block);
  const firstLocal = plan.cellLocals.get(first);
  const secondLocal = plan.cellLocals.get(second);

  ok(firstLocal !== undefined);
  ok(secondLocal !== undefined);
  strictEqual(firstLocal === secondLocal, false);
  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      cellLocals: new Map([[first, firstLocal], [second, firstLocal]])
    }),
    /overlap in local/
  );

  const wrongTypes = [...plan.localTypes];

  wrongTypes[firstLocal] = "i64";
  throws(
    () => validatePlacement(block, analysis, { ...plan, localTypes: wrongTypes }),
    /has the wrong type in local/
  );

  const unrelated = new CellRef("i32");

  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      cellLocals: new Map([...plan.cellLocals, [unrelated, plan.localTypes.length]]),
      localTypes: [...plan.localTypes, "i32"]
    }),
    /cell local has no referenced cell/
  );

});

test("cells with disjoint lifetimes pool one local", () => {
  const values = compilerTestValues();
  const first = new CellRef("i32");
  const second = new CellRef("i32");
  const firstOut = values.addActionOutput();
  const secondOut = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(first, values.const(1), "seed"),
        read(first, firstOut),
        resourceWriteAction(values, 0, firstOut),
        write(second, values.const(2), "seed"),
        read(second, secondOut),
        resourceWriteAction(values, 1, secondOut)
      ]
    }
  };
  const { plan } = place(block);

  strictEqual(plan.cellLocals.get(first), plan.cellLocals.get(second));
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("a loop-crossing cell stays live through the whole loop", () => {
  const values = compilerTestValues();
  const outer = new CellRef("i32");
  const inner = new CellRef("i32");
  const outerOut = values.addActionOutput();
  const innerOut = values.addActionOutput();
  const loopBody: Body = {
    actions: [
      read(outer, outerOut),
      resourceWriteAction(values, 0, outerOut),
      write(inner, values.const(5), "seed"),
      read(inner, innerOut),
      resourceWriteAction(values, 1, innerOut)
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        write(outer, values.const(1), "seed"),
        { kind: "loop", carried: [], body: loopBody }
      ]
    }
  };
  const { plan } = place(block);
  const outerLocal = plan.cellLocals.get(outer);
  const innerLocal = plan.cellLocals.get(inner);

  ok(outerLocal !== undefined);
  ok(innerLocal !== undefined);
  // The back edge keeps the outer cell live for the entire loop: its next
  // iteration reads after the inner cell's textually later seed. Without
  // widening, the two lifetimes would look disjoint and wrongly share.
  strictEqual(outerLocal === innerLocal, false);
});
