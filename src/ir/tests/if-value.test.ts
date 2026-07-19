import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ifControl } from "#compiler/ir/controls/index.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import { RegionBuilder } from "#ir/region-builder.js";
import type { IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import {
  compilerTestResourceEffect,
  compilerTestValues
} from "#ir/tests/storage-op-helpers.js";

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
  const values = compilerTestValues();
  const body = new RegionBuilder(values);
  const condition = values.external(0);
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
  const block = { values, body: body.build() };
  const control = block.body.nodes[0];

  ok(control?.kind === "if" && control.output !== undefined && control.elseBody !== undefined);
  strictEqual(control.output, output);
  strictEqual(control.hint, "unlikely");
  strictEqual(control.thenBody.result, thenResult);
  strictEqual(control.elseBody.result, elseResult);
  strictEqual(control.outputs[0], output);
  ok(thenResult < output);
  ok(elseResult < output);
  deepStrictEqual(values.widthBounds(output), {
    unsignedBits: 32,
    signedBits: signExtended(16).signedBits
  });
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("ifValue ignores an unreachable arm when joining bounds", () => {
  const values = compilerTestValues();
  const body = new RegionBuilder(values);
  const output = body.ifValue(
    values.external(0),
    (then) => then.values.const(0),
    (otherwise) => otherwise.values.unreachable()
  );

  strictEqual(values.widthBounds(output).unsignedBits, 1);
  strictEqual(values.widthBounds(output).signedBits, 1);
});

test("validation rejects a control output narrower than an arm result", () => {
  const values = compilerTestValues();
  const condition = values.const(1);
  const armResult = values.addNodeOutput();
  const fallback = values.const(0);
  const output = values.addNodeOutput(fitsUnsigned(8));
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
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
      })]
    }
  };

  throws(
    () => validateIrBlock(block, { allowImplicitEntryFallthrough: true }),
    /result bounds exceed its owner output bounds/
  );
});

test("a value-producing if requires an else body and arm results", () => {
  const missingElseValues = new ValueTable();
  const condition = missingElseValues.const(1);
  const result = missingElseValues.const(7);
  const output = missingElseValues.addNodeOutput();
  const missingElse = ifControl.create({
    condition,
    output,
    thenBody: { nodes: [], result }
  });

  throws(
    () => validateIrBlock({
      values: missingElseValues,
      body: { nodes: [missingElse] }
    }, { allowImplicitEntryFallthrough: true }),
    /value-producing if is missing its else body/
  );

  const missingResultValues = new ValueTable();
  const missingResultCondition = missingResultValues.const(1);
  const missingResultOutput = missingResultValues.addNodeOutput();
  const missingResult = ifControl.create({
    condition: missingResultCondition,
    output: missingResultOutput,
    thenBody: { nodes: [] },
    elseBody: { nodes: [], result: missingResultCondition }
  });

  throws(
    () => validateIrBlock({
      values: missingResultValues,
      body: { nodes: [missingResult] }
    }, { allowImplicitEntryFallthrough: true }),
    /thenBody must carry a result/
  );
});
