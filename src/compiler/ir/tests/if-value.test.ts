import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ifControl } from "#compiler/ir/controls/index.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import { buildFunction } from "#compiler/ir/builder/function.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { functionType } from "#compiler/ir/function.js";
import { describeNode } from "#compiler/ir/node.js";
import { compilerTestResourceEffect } from "#test/support/storage-operations.js";

function readArgs(values: ValueTable, region: number, width: IntegerWidth, signed?: true) {
  const source = {
    effect: compilerTestResourceEffect(region, width / 8),
    address: { base: values.const(0), displacement: region * 4 },
    width
  };

  return signed === true ? { source, mode: { kind: "signed" as const } } : { source };
}

test("ifValue joins its arm results into one output", () => {
  let thenResult!: ValueId;
  let elseResult!: ValueId;
  let output!: ValueId;
  const block = buildFunction(functionType(["i32"], []), (fn) => {
    const [condition] = fn.parameters;

    ok(condition !== undefined);
    output = fn.region.ifValue(
      condition,
      (then) => (thenResult = then.operation(resourceRead, readArgs(then.values, 0, 8))),
      (otherwise) =>
        (elseResult = otherwise.operation(resourceRead, readArgs(otherwise.values, 0, 16, true))),
      { hint: "unlikely" }
    );
    fn.return([]);
  });
  const control = block.body.nodes[0];

  ok(control?.kind === "if" && control.output !== undefined && control.elseBody !== undefined);
  strictEqual(control.output, output);
  strictEqual(control.hint, "unlikely");
  strictEqual(control.thenBody.result, thenResult);
  strictEqual(control.elseBody.result, elseResult);
  deepStrictEqual(describeNode(control).outputs, [output]);
  deepStrictEqual(block.values.widthBounds(output), {
    unsignedBits: 32,
    signedBits: 16
  });
  doesNotThrow(() => validateIrFunction(block));
});

test("ifValue ignores an unreachable arm when joining bounds", () => {
  let output!: ValueId;
  const built = buildFunction(functionType(["i32"], []), (fn) => {
    const [condition] = fn.parameters;

    ok(condition !== undefined);
    output = fn.region.ifValue(
      condition,
      (then) => then.values.const(0),
      (otherwise) => otherwise.values.unreachable()
    );
    fn.return([]);
  });

  strictEqual(built.values.widthBounds(output).unsignedBits, 1);
  strictEqual(built.values.widthBounds(output).signedBits, 1);
  doesNotThrow(() => validateIrFunction(built));
});

test("validation rejects a control output narrower than an arm result", () => {
  const block = buildFunction(functionType([], []), (fn) => {
    const condition = fn.values.const(1);
    const fallback = fn.values.const(0);
    const armResult = fn.values.addNodeOutput();
    const output = fn.values.addNodeOutput(fitsUnsigned(8));

    fn.region.push(
      ifControl.create({
        condition,
        output,
        thenBody: {
          nodes: [resourceRead.create(readArgs(fn.values, 0, 32), () => armResult)],
          result: armResult
        },
        elseBody: { nodes: [], result: fallback }
      })
    );
    fn.return([]);
  });

  throws(() => validateIrFunction(block), /result bounds exceed its owner output bounds/);
});

test("a value-producing if requires an else body and arm results", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const result = values.const(7);
  const output = values.addNodeOutput();

  throws(
    () =>
      ifControl.create({
        condition,
        output,
        thenBody: { nodes: [], result }
      }),
    /value-producing if is missing its else body/
  );

  const missingResultFn = buildFunction(functionType([], []), (fn) => {
    const condition = fn.values.const(1);
    const output = fn.values.addNodeOutput();
    const missingResult = ifControl.create({
      condition,
      output,
      thenBody: { nodes: [] },
      elseBody: { nodes: [], result: condition }
    });

    fn.region.push(missingResult);
    fn.return([]);
  });

  throws(() => validateIrFunction(missingResultFn), /thenBody must carry a result/);
});
