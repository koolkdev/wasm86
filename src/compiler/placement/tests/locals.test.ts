import {
  ok,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  ifControl,
  loopControl
} from "#compiler/ir/controls/index.js";
import { VariableRef } from "#compiler/ir/variable.js";
import { variableRead, variableWrite } from "#compiler/ir/operations/variables.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { placeFunction } from "#compiler/placement/place.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { Region } from "#compiler/ir/region.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import {
  compilerTestValues,
  resourceReadNode,
  resourceWriteNode
} from "#test/support/storage-operations.js";
import { completedPlacementFunction } from "./function-fixture.js";

function write(
  variable: VariableRef,
  value: ValueId,
  initialization: "seed" | "update"
): Extract<Operation, { kind: "variable.write" }> {
  return variableWrite.create({ variable, value, initialization });
}

function read(
  variable: VariableRef,
  output: ValueId
): Extract<Operation, { kind: "variable.read" }> {
  return variableRead.create({ variable }, () => output);
}

function place(block: FunctionGraph, parameterCount = 0) {
  return placeFunction(completedPlacementFunction(block, parameterCount));
}

test("placement assigns one typed local to a referenced variable", () => {
  const values = compilerTestValues();
  const variable = new VariableRef("i32");
  const output = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(variable, values.const(7), "seed"),
        read(variable, output),
        resourceWriteNode(values, 0, output)
      ]
    }
  };
  const { plan } = place(block);
  const local = plan.variableLocals.get(variable);

  ok(local !== undefined);
  strictEqual(plan.localTypes[local], "i32");
});

test("variable locals are allocated when a variable has only writes", () => {
  const values = compilerTestValues();
  const variable = new VariableRef("i32");
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(variable, values.const(0), "seed"),
        write(variable, values.const(1), "update")
      ]
    }
  };
  const { plan } = place(block);
  const local = plan.variableLocals.get(variable);

  ok(local !== undefined);
  strictEqual(plan.localTypes[local], "i32");
});

test("distinct variables receive distinct locals with their scalar types", () => {
  const values = compilerTestValues();
  const narrow = new VariableRef("i32");
  const wide = new VariableRef("i64");
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(narrow, values.const(1), "seed"),
        write(wide, values.const64(2n), "seed")
      ]
    }
  };
  const { plan } = place(block);
  const narrowLocal = plan.variableLocals.get(narrow);
  const wideLocal = plan.variableLocals.get(wide);

  ok(narrowLocal !== undefined);
  ok(wideLocal !== undefined);
  strictEqual(narrowLocal === wideLocal, false);
  strictEqual(plan.localTypes[narrowLocal], "i32");
  strictEqual(plan.localTypes[wideLocal], "i64");
});

test("nested branch and loop accesses share the declaring variable's local", () => {
  const values = compilerTestValues();
  const variable = new VariableRef("i32");
  const output = values.addNodeOutput();
  const loopBody: Region = {
    nodes: [
      write(variable, values.const(3), "update"),
      read(variable, output),
      resourceWriteNode(values, 0, output)
    ]
  };
  const thenBody: Region = {
    nodes: [loopControl.create({ carried: [], body: loopBody })]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(variable, values.const(1), "seed"),
        ifControl.create({ condition: values.parameter(0, "i32"), thenBody })
      ]
    }
  };
  const { plan } = place(block, 1);

  strictEqual(plan.variableLocals.size, 1);
  strictEqual(plan.variableLocals.has(variable), true);
});

test("a variable never shares a local with an overlapping value temporary", () => {
  const values = compilerTestValues();
  const variable = new VariableRef("i32");
  const snapshot = values.addNodeOutput();
  const output = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, snapshot, 0),
        resourceWriteNode(values, 0, values.const(9)),
        write(variable, values.const(1), "seed"),
        read(variable, output),
        resourceWriteNode(values, 1, snapshot),
        resourceWriteNode(values, 2, output)
      ]
    }
  };
  const { function: fn, analysis, plan } = place(block);
  const valuePlacement = plan.values[snapshot];
  const variableLocal = plan.variableLocals.get(variable);

  strictEqual(valuePlacement?.kind, "capture");
  ok(variableLocal !== undefined);
  if (valuePlacement?.kind !== "capture") {
    throw new Error("snapshot did not receive a value local");
  }
  strictEqual(variableLocal === valuePlacement.local, false);

  throws(
    () => validatePlacement(fn, analysis, { ...plan, variableLocals: new Map() }),
    /referenced variable has no local/
  );
  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      variableLocals: new Map([[variable, valuePlacement.local]])
    }),
    /overlap in local/
  );
});

test("placement validation rejects overlapping and mistyped variable locals", () => {
  const values = compilerTestValues();
  const first = new VariableRef("i32");
  const second = new VariableRef("i32");
  const firstOut = values.addNodeOutput();
  const secondOut = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(first, values.const(1), "seed"),
        write(second, values.const(2), "seed"),
        read(first, firstOut),
        read(second, secondOut),
        resourceWriteNode(values, 0, firstOut),
        resourceWriteNode(values, 1, secondOut)
      ]
    }
  };
  const { function: fn, analysis, plan } = place(block);
  const firstLocal = plan.variableLocals.get(first);
  const secondLocal = plan.variableLocals.get(second);

  ok(firstLocal !== undefined);
  ok(secondLocal !== undefined);
  strictEqual(firstLocal === secondLocal, false);
  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      variableLocals: new Map([[first, firstLocal], [second, firstLocal]])
    }),
    /overlap in local/
  );

  const wrongTypes = [...plan.localTypes];

  wrongTypes[firstLocal] = "i64";
  throws(
    () => validatePlacement(fn, analysis, { ...plan, localTypes: wrongTypes }),
    /has the wrong type in local/
  );
});

test("variables with disjoint lifetimes pool one local", () => {
  const values = compilerTestValues();
  const first = new VariableRef("i32");
  const second = new VariableRef("i32");
  const firstOut = values.addNodeOutput();
  const secondOut = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(first, values.const(1), "seed"),
        read(first, firstOut),
        resourceWriteNode(values, 0, firstOut),
        write(second, values.const(2), "seed"),
        read(second, secondOut),
        resourceWriteNode(values, 1, secondOut)
      ]
    }
  };
  const { plan } = place(block);

  const firstLocal = plan.variableLocals.get(first);
  const secondLocal = plan.variableLocals.get(second);

  ok(firstLocal !== undefined);
  ok(secondLocal !== undefined);
  strictEqual(firstLocal, secondLocal);
  strictEqual(plan.localTypes[firstLocal], "i32");
});

test("a loop-crossing variable stays live through the whole loop", () => {
  const values = compilerTestValues();
  const outer = new VariableRef("i32");
  const inner = new VariableRef("i32");
  const outerOut = values.addNodeOutput();
  const innerOut = values.addNodeOutput();
  const loopBody: Region = {
    nodes: [
      read(outer, outerOut),
      resourceWriteNode(values, 0, outerOut),
      write(inner, values.const(5), "seed"),
      read(inner, innerOut),
      resourceWriteNode(values, 1, innerOut)
    ]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        write(outer, values.const(1), "seed"),
        loopControl.create({ carried: [], body: loopBody })
      ]
    }
  };
  const { plan } = place(block);
  const outerLocal = plan.variableLocals.get(outer);
  const innerLocal = plan.variableLocals.get(inner);

  ok(outerLocal !== undefined);
  ok(innerLocal !== undefined);
  // The back edge keeps the outer variable live for the entire loop: its next
  // iteration reads after the inner variable's textually later seed. Without
  // widening, the two lifetimes would look disjoint and wrongly share.
  strictEqual(outerLocal === innerLocal, false);
});
