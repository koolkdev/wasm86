import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ifControl } from "#compiler/ir/controls/index.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import { FunctionBuilder } from "#compiler/ir/builder/function.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { functionType } from "#compiler/ir/function.js";
import { compilerTestResourceEffect } from "#test/support/storage-operations.js";

function readArgs(
  values: ValueTable,
  region: number,
  width: IntegerWidth,
  signed?: true
) {
  const source = {
    effect: compilerTestResourceEffect(region, width / 8),
    address: { base: values.const(0), displacement: region * 4 },
    width
  };

  return signed === true
    ? { source, mode: { kind: "signed" as const } }
    : { source };
}

test("ifValue joins its arm results into one output", () => {
  const fn = new FunctionBuilder(functionType(["i32"], []));
  const values = fn.values;
  const body = fn.region;
  const [condition] = fn.parameters;

  ok(condition !== undefined);
  let thenResult!: ValueId;
  let elseResult!: ValueId;
  const output = body.ifValue(
    condition,
    (then) => (thenResult = then.operation(resourceRead, readArgs(then.values, 0, 8))),
    (otherwise) => (elseResult = otherwise.operation(
      resourceRead,
      readArgs(otherwise.values, 0, 16, true)
    )),
    { hint: "unlikely" }
  );
  fn.return([]);
  const block = fn.finish();
  const control = block.body.nodes[0];

  ok(control?.kind === "if" && control.output !== undefined && control.elseBody !== undefined);
  strictEqual(control.output, output);
  strictEqual(control.hint, "unlikely");
  strictEqual(control.thenBody.result, thenResult);
  strictEqual(control.elseBody.result, elseResult);
  strictEqual(control.outputs[0], output);
  deepStrictEqual(values.widthBounds(output), {
    unsignedBits: 32,
    signedBits: 16
  });
  doesNotThrow(() => validateIrFunction(block));
});

test("ifValue ignores an unreachable arm when joining bounds", () => {
  const fn = new FunctionBuilder(functionType(["i32"], []));
  const [condition] = fn.parameters;

  ok(condition !== undefined);
  const output = fn.region.ifValue(
    condition,
    (then) => then.values.const(0),
    (otherwise) => otherwise.values.unreachable()
  );
  fn.return([]);
  const built = fn.finish();

  strictEqual(built.values.widthBounds(output).unsignedBits, 1);
  strictEqual(built.values.widthBounds(output).signedBits, 1);
  doesNotThrow(() => validateIrFunction(built));
});

test("validation rejects a control output narrower than an arm result", () => {
  const fn = new FunctionBuilder(functionType([], []));
  const values = fn.values;
  const condition = values.const(1);
  const fallback = values.const(0);
  const armResult = values.addNodeOutput();
  const output = values.addNodeOutput(fitsUnsigned(8));
  fn.region.push(ifControl.create({
    condition,
    output,
    thenBody: {
      nodes: [resourceRead.create(
        readArgs(values, 0, 32),
        () => armResult
      )],
      result: armResult
    },
    elseBody: { nodes: [], result: fallback }
  }));
  fn.return([]);
  const block = fn.finish();

  throws(
    () => validateIrFunction(block),
    /result bounds exceed its owner output bounds/
  );
});

test("a value-producing if requires an else body and arm results", () => {
  const missingElseFn = new FunctionBuilder(functionType([], []));
  const missingElseValues = missingElseFn.values;
  const condition = missingElseValues.const(1);
  const result = missingElseValues.const(7);
  const output = missingElseValues.addNodeOutput();
  const missingElse = ifControl.create({
    condition,
    output,
    thenBody: { nodes: [], result }
  });

  missingElseFn.region.push(missingElse);
  missingElseFn.return([]);

  throws(
    () => validateIrFunction(missingElseFn.finish()),
    /value-producing if is missing its else body/
  );

  const missingResultFn = new FunctionBuilder(functionType([], []));
  const missingResultValues = missingResultFn.values;
  const missingResultCondition = missingResultValues.const(1);
  const missingResultOutput = missingResultValues.addNodeOutput();
  const missingResult = ifControl.create({
    condition: missingResultCondition,
    output: missingResultOutput,
    thenBody: { nodes: [] },
    elseBody: { nodes: [], result: missingResultCondition }
  });

  missingResultFn.region.push(missingResult);
  missingResultFn.return([]);

  throws(
    () => validateIrFunction(missingResultFn.finish()),
    /thenBody must carry a result/
  );
});
