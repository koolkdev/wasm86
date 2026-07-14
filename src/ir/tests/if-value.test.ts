import { deepStrictEqual, doesNotThrow, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { stateRead } from "#compiler/ir/operations/state.js";
import { BodyBuilder } from "#ir/body-builder.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { actionOutput } from "#ir/traverse.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned, signExtended } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";

test("ifValue joins its arm results into one output", () => {
  const values = new ValueTable();
  const body = new BodyBuilder(values);
  const condition = values.external(0);
  let thenResult!: ValueId;
  let elseResult!: ValueId;
  const output = body.ifValue(
    condition,
    (then) => (thenResult = then.operation(stateRead.create({ slot: gprChannel("al") }))),
    (otherwise) => (elseResult = otherwise.operation(
      stateRead.create({ slot: gprChannel("ax"), signed: true })
    )),
    { hint: "unlikely" }
  );
  const block = { values, body: body.build() };
  const action = block.body.actions[0];

  ok(action?.kind === "if" && action.output !== undefined && action.elseBody !== undefined);
  strictEqual(action.output, output);
  strictEqual(action.hint, "unlikely");
  strictEqual(action.thenBody.result, thenResult);
  strictEqual(action.elseBody.result, elseResult);
  strictEqual(actionOutput(action), output);
  ok(thenResult < output);
  ok(elseResult < output);
  deepStrictEqual(values.widthBounds(output), {
    unsignedBits: 32,
    signedBits: signExtended(16).signedBits
  });
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("ifValue ignores an unreachable arm when joining bounds", () => {
  const values = new ValueTable();
  const body = new BodyBuilder(values);
  const output = body.ifValue(
    values.external(0),
    (then) => then.values.const(0),
    (otherwise) => otherwise.values.unreachable()
  );

  strictEqual(values.widthBounds(output).unsignedBits, 1);
  strictEqual(values.widthBounds(output).signedBits, 1);
});

test("validation rejects a control output narrower than an arm result", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const armResult = values.addActionOutput();
  const fallback = values.const(0);
  const output = values.addActionOutput(fitsUnsigned(8));
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition,
        output,
        thenBody: {
          actions: [{
            kind: "op",
            output: armResult,
            op: stateRead.create({ slot: gprChannel("eax") })
          }],
          result: armResult
        },
        elseBody: { actions: [], result: fallback }
      }]
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
  const output = missingElseValues.addActionOutput();
  const missingElse = {
    kind: "if",
    condition,
    output,
    thenBody: { actions: [], result }
  } as unknown as Action;

  throws(
    () => validateIrBlock({
      values: missingElseValues,
      body: { actions: [missingElse] }
    }, { allowImplicitEntryFallthrough: true }),
    /value-producing if is missing its else body/
  );

  const missingResultValues = new ValueTable();
  const missingResultCondition = missingResultValues.const(1);
  const missingResultOutput = missingResultValues.addActionOutput();
  const missingResult: Action = {
    kind: "if",
    condition: missingResultCondition,
    output: missingResultOutput,
    thenBody: { actions: [] },
    elseBody: { actions: [], result: missingResultCondition }
  };

  throws(
    () => validateIrBlock({
      values: missingResultValues,
      body: { actions: [missingResult] }
    }, { allowImplicitEntryFallthrough: true }),
    /thenBody must carry a result/
  );
});
