import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { maxSwitchMatch, type Action, type SwitchAction } from "#ir/actions.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { Body, IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { varWrite } from "#compiler/ir/operations/variables.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

function blockWith(actions: readonly Action[]): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 10; value += 1) {
    values.const(value);
  }

  return { body: { actions }, values };
}

function entryBlock(values: ValueTable, actions: readonly Action[]): IrBlock {
  return {
    values,
    body: { actions }
  };
}

function finishDispatch(targetEip: number): Action {
  return { kind: "finish", finish: { kind: "dispatch", targetEip: valueId(targetEip) } };
}

function finishExit(reason: "unsupported" = "unsupported"): Action {
  return { kind: "finish", finish: { kind: "exit", exit: { class: "host", reason } } };
}

const finishDispatch0 = finishDispatch(0);
const writeEip0 = stateWrite(eipChannel, 0);
const writeEip1 = stateWrite(eipChannel, 1);

test("a body ending with a finish exit validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith([finishExit()])));
});

test("a body ending with a finish dispatch validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith([finishDispatch0])));
});

test("an implicit fragment body end validates only when allowed", () => {
  const block = blockWith([stateWrite(gprChannel("eax"), 0)]);

  throws(() => validateIrBlock(block), /root body does not complete/);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("a terminal if with both bodies complete validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        {
          kind: "if",
          condition: valueId(0),
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishDispatch(1)] }
        }
      ])
    )
  );
});

test("an action after the finish exit terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          finishExit(),
          stateWrite(eipChannel, 0)
        ])
      ),
    /has actions after its terminal finish action/
  );
});

test("an action after a finish dispatch terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(blockWith([finishDispatch0, stateWrite(eipChannel, 0)])),
    /has actions after its terminal finish action/
  );
});

test("an action after a terminal if is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
        {
          kind: "if",
          condition: valueId(0),
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishExit()] }
        },
          stateWrite(eipChannel, 0)
        ])
      ),
    /has actions after its terminal if action/
  );
});

test("a body that does not complete is rejected", () => {
  throws(
    () => validateIrBlock(blockWith([stateWrite(eipChannel, 0)])),
    /root body does not complete/
  );
});

test("dispatch target must be a known value", () => {
  throws(
    () => validateIrBlock(blockWith([finishDispatch(99)])),
    /unknown value id 99/
  );
});

test("op action output bounds must match the op signature", () => {
  const missingBounds = new ValueTable();
  const missingBoundsAddress = missingBounds.const(0);
  const missingBoundsOutput = missingBounds.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(missingBounds, [
          memoryRead(missingBoundsOutput, missingBoundsAddress, 8),
          finishExit()
        ])
      ),
    /memory\.read op action output \d+ has the wrong bounds/
  );

  const overlyNarrow = new ValueTable();
  const overlyNarrowAddress = overlyNarrow.const(0);
  const overlyNarrowOutput = overlyNarrow.addActionOutput(fitsUnsigned(8));

  throws(
    () =>
      validateIrBlock(
        entryBlock(overlyNarrow, [
          memoryRead(overlyNarrowOutput, overlyNarrowAddress, 32),
          finishExit()
        ])
      ),
    /memory\.read op action output \d+ has the wrong bounds/
  );
});

test("a root dispatch EIP write is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          stateWrite(eipChannel, 1),
          stateWrite(gprChannel("eax"), 1),
          finishDispatch0
        ])
      ),
    /body dispatch path must not flush EIP state/
  );
});

test("a nested dispatch validates without an EIP flush", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        {
          kind: "if",
          condition: valueId(1),
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishExit()] }
        }
      ])
    )
  );
});

test("a nested dispatch rejects an ancestor EIP write", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          writeEip0,
          {
            kind: "if",
            condition: valueId(0),
            thenBody: { actions: [finishDispatch0] },
            elseBody: { actions: [finishExit()] }
          }
        ])
      ),
    /thenBody dispatch path must not flush EIP state/
  );
});

function switchBlock(overrides: Partial<SwitchAction>): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 5; value += 1) {
    values.const(value);
  }

  const action: SwitchAction = {
    kind: "switch",
    selector: valueId(0),
    output: values.addActionOutput(),
    cases: [
      { match: 0, body: { actions: [], result: valueId(2) } },
      { match: 2, body: { actions: [], result: valueId(3) } }
    ],
    defaultBody: { actions: [], result: valueId(4) },
    ...overrides
  };

  return entryBlock(values, [action, finishExit()]);
}

test("a switch whose bodies all carry results validates", () => {
  doesNotThrow(() => validateIrBlock(switchBlock({})));
});

test("an escaping switch body is rejected until a producer arrives", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: 0, body: { actions: [finishExit()] } }] })),
    /case\[0\] must carry a result/
  );
});

test("a result on the root body is rejected", () => {
  const values = new ValueTable();
  const result = values.const(1);

  throws(
    () => validateIrBlock({ values, body: { actions: [finishExit()], result } }),
    /body carries a result without an owner output/
  );
});

test("a result under an output-less owner is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "if",
            condition: valueId(0),
            thenBody: { actions: [finishExit()], result: valueId(1) }
          },
          finishExit()
        ])
      ),
    /thenBody carries a result without an owner output/
  );
});

test("a result on a completing body is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: 0, body: { actions: [finishExit()], result: valueId(2) } }] })),
    /case\[0\] carries a result but completes/
  );
});

test("an output-owner body that neither escapes nor carries a result is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ defaultBody: { actions: [] } })),
    /default must carry a result/
  );
});

test("a duplicate switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        switchBlock({
          cases: [
            { match: 1, body: { actions: [], result: valueId(2) } },
            { match: 1, body: { actions: [], result: valueId(3) } }
          ]
        })
      ),
    /has a duplicate case match 1/
  );
});

test("a negative switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: -1, body: { actions: [], result: valueId(2) } }] })),
    /case match -1 is not an integer in \[0, 255\]/
  );
});

test("a switch case match beyond the dense-table bound is rejected", () => {
  doesNotThrow(() =>
    validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch, body: { actions: [], result: valueId(2) } }] }))
  );
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch + 1, body: { actions: [], result: valueId(2) } }] })),
    /case match 256 is not an integer in \[0, 255\]/
  );
});

test("a switch without a default body is rejected", () => {
  const missingDefault = switchBlock({ defaultBody: undefined as unknown as Body });

  throws(
    () => validateIrBlock(missingDefault),
    /is missing its default body/
  );
});

test("a nested dispatch EIP write is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "if",
            condition: valueId(0),
            thenBody: { actions: [writeEip1, finishDispatch0] },
            elseBody: { actions: [finishExit()] }
          }
        ])
      ),
    /thenBody dispatch path must not flush EIP state/
  );
});

test("a loop with a dword carried cell and an aligned continue validates", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const update = values.binary("sub", loopInput, values.const(1));

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        {
          kind: "loop",
          carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
          body: {
            actions: [
              { kind: "if", condition: update, thenBody: { actions: [{ kind: "loopContinue", updates: [update] }] } },
              stateWrite(gprChannel("ecx"), update)
            ]
          }
        },
        finishDispatch0
      ])
    )
  );
});

test("a var op with an invalid index is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([{
          kind: "op",
          op: varWrite.create({ variable: -1, value: valueId(0) })
        }])
      ),
    /invalid semantic var index/
  );
});

test("a loopContinue outside any loop body is rejected", () => {
  throws(
    () => validateIrBlock(blockWith([{ kind: "loopContinue", updates: [] }])),
    /loopContinue outside any loop body/
  );
});

test("loopContinue updates misaligned with the carried list are rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: { actions: [{ kind: "loopContinue", updates: [] }] }
          },
          finishDispatch0
        ])
      ),
    /updates do not align/
  );
});

test("a narrow GPR carried channel validates", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();

  doesNotThrow(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("cl"), seed, loopInput }],
            body: { actions: [{ kind: "loopContinue", updates: [loopInput] }] }
          },
          finishDispatch0
        ])
      )
  );
});

test("a loop body state access partially overlapping a carried channel is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const partialRead = values.addActionOutput(fitsUnsigned(8));

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: {
              actions: [
                stateRead(partialRead, gprChannel("cl")),
                { kind: "loopContinue", updates: [loopInput] }
              ]
            }
          },
          finishDispatch0
        ])
      ),
    /loop body read partially overlaps a carried channel/
  );
});

test("a carried cell whose input is not a loopInput value is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput: seed }],
            body: { actions: [{ kind: "loopContinue", updates: [seed] }] }
          },
          finishDispatch0
        ])
      ),
    /is not a loopInput value/
  );
});

test("used and unused action outputs without producers are rejected", () => {
  const unusedValues = new ValueTable();

  unusedValues.addActionOutput();
  throws(
    () => validateIrBlock(entryBlock(unusedValues, [finishExit()])),
    /action output \d+ has no producer/
  );

  const usedValues = new ValueTable();
  const used = usedValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(usedValues, [stateWrite(gprChannel("eax"), used), finishExit()])
      ),
    /action output \d+ has no producer/
  );
});

test("producer outputs must name actionOutput values", () => {
  const constValues = new ValueTable();
  const constant = constValues.const(0);

  throws(
    () => validateIrBlock(entryBlock(constValues, [stateRead(constant, gprChannel("eax")), finishExit()])),
    /producer output \d+ is not an actionOutput value/
  );

  const compoundValues = new ValueTable();
  const compound = compoundValues.binary("add", compoundValues.external(0), compoundValues.const(1));

  throws(
    () => validateIrBlock(entryBlock(compoundValues, [stateRead(compound, gprChannel("eax")), finishExit()])),
    /producer output \d+ is not an actionOutput value/
  );

  const loopValues = new ValueTable();
  const loopInput = loopValues.addLoopInput();

  throws(
    () => validateIrBlock(entryBlock(loopValues, [stateRead(loopInput, gprChannel("eax")), finishExit()])),
    /producer output \d+ is not an actionOutput value/
  );
});

test("duplicate op producers and op-vs-switch producers are rejected", () => {
  const opValues = new ValueTable();
  const opOutput = opValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(opValues, [
          stateRead(opOutput, gprChannel("eax")),
          stateRead(opOutput, gprChannel("ebx")),
          finishExit()
        ])
      ),
    /action output \d+ has more than one producer/
  );

  const mixedValues = new ValueTable();
  const selector = mixedValues.const(0);
  const result = mixedValues.const(1);
  const mixedOutput = mixedValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(mixedValues, [
          stateRead(mixedOutput, gprChannel("eax")),
          {
            kind: "switch",
            selector,
            output: mixedOutput,
            cases: [{ match: 0, body: { actions: [], result } }],
            defaultBody: { actions: [], result }
          },
          finishExit()
        ])
      ),
    /action output \d+ has more than one producer/
  );
});

test("a same-body compound use before its producer is rejected", () => {
  const directValues = new ValueTable();
  const directOutput = directValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(directValues, [
          stateWrite(gprChannel("eax"), directOutput),
          stateRead(directOutput, gprChannel("ebx")),
          finishExit()
        ])
      ),
    /action output \d+.*does not dominate/
  );

  const values = new ValueTable();
  const output = values.addActionOutput();
  const compound = values.binary("add", output, values.external(0));

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          stateWrite(gprChannel("eax"), compound),
          stateRead(output, gprChannel("ebx")),
          finishExit()
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("an action output cannot be used from a sibling body", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const output = values.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "if",
            condition,
            thenBody: { actions: [stateRead(output, gprChannel("eax"))] },
            elseBody: { actions: [stateWrite(gprChannel("ebx"), output)] }
          },
          finishExit()
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("one Body object cannot be reused under multiple control actions", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const shared: Body = { actions: [] };

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          { kind: "if", condition, thenBody: shared },
          { kind: "if", condition, thenBody: shared },
          finishExit()
        ])
      ),
    /reuses a Body object that already has an owner/
  );
});

test("a loop input is scoped to its owning loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: { actions: [] }
          },
          stateWrite(gprChannel("eax"), loopInput),
          finishExit()
        ])
      ),
    /loop input \d+ is used outside its owning loop body/
  );
});

test("a loop input cannot be reused by a sibling loop", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: { actions: [] }
          },
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: { actions: [] }
          },
          finishExit()
        ])
      ),
    /reuses loop input \d+ across carried cells or loops/
  );
});

test("a loop input cannot be consumed inside a sibling loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [{ channel: gprChannel("ecx"), seed, loopInput }],
            body: { actions: [] }
          },
          {
            kind: "loop",
            carried: [],
            body: { actions: [stateWrite(gprChannel("eax"), loopInput)] }
          },
          finishExit()
        ])
      ),
    /loop input \d+ is used outside its owning loop body/
  );
});

test("a loop-body action output cannot escape directly after the loop", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [],
            body: { actions: [stateRead(output, gprChannel("eax"))] }
          },
          stateWrite(gprChannel("ebx"), output),
          finishExit()
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("a switch output cannot be its own selector or arm result", () => {
  const selectorValues = new ValueTable();
  const selectorResult = selectorValues.const(1);
  const selectorOutput = selectorValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(selectorValues, [
          {
            kind: "switch",
            selector: selectorOutput,
            output: selectorOutput,
            cases: [{ match: 0, body: { actions: [], result: selectorResult } }],
            defaultBody: { actions: [], result: selectorResult }
          },
          finishExit()
        ])
      ),
    /switch selector \d+ created after its output/
  );

  const resultValues = new ValueTable();
  const resultSelector = resultValues.const(0);
  const resultOutput = resultValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(resultValues, [
          {
            kind: "switch",
            selector: resultSelector,
            output: resultOutput,
            cases: [{ match: 0, body: { actions: [], result: resultOutput } }],
            defaultBody: { actions: [], result: resultSelector }
          },
          finishExit()
        ])
      ),
    /switch result \d+ created after its output/
  );
});

test("a valid switch output can be used after the switch", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const result = values.const(1);
  const output = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        {
          kind: "switch",
          selector,
          output,
          cases: [{ match: 0, body: { actions: [], result } }],
          defaultBody: { actions: [], result }
        },
        stateWrite(gprChannel("eax"), output),
        finishExit()
      ])
    )
  );
});

test("an ancestor producer can feed nested if, switch-result, and loop-body uses", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const output = values.addActionOutput();
  const fallback = values.const(0);
  const switchOutput = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        stateRead(output, gprChannel("eax")),
        {
          kind: "if",
          condition,
          thenBody: { actions: [stateWrite(gprChannel("ebx"), output)] }
        },
        {
          kind: "switch",
          selector: condition,
          output: switchOutput,
          cases: [{ match: 0, body: { actions: [], result: output } }],
          defaultBody: { actions: [], result: fallback }
        },
        {
          kind: "loop",
          carried: [],
          body: { actions: [stateWrite(gprChannel("ecx"), output)] }
        },
        finishExit()
      ])
    )
  );
});

test("a body-local producer can feed its body result", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const armOutput = values.addActionOutput();
  const formula = values.binary("add", armOutput, values.const(1));
  const fallback = values.const(7);
  const switchOutput = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        {
          kind: "switch",
          selector,
          output: switchOutput,
          cases: [
            {
              match: 0,
              body: {
                actions: [stateRead(armOutput, gprChannel("eax"))],
                result: formula
              }
            }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        finishExit()
      ])
    )
  );
});

test("producer operands must have lower value ids than their output", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const address = values.const(0x2000);

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          memoryRead(output, address, 32),
          finishExit()
        ])
      ),
    /producer operand \d+ created after its output/
  );
});

test("exported outputs are validated at the root body boundary", () => {
  const validValues = new ValueTable();
  const validOutput = validValues.addActionOutput();
  const validBlock = entryBlock(validValues, [
    stateRead(validOutput, gprChannel("eax")),
    finishExit()
  ]);

  doesNotThrow(() => validateIrBlock(validBlock, { exportedOutputs: [validOutput] }));

  const escapingValues = new ValueTable();
  const condition = escapingValues.const(1);
  const escapingOutput = escapingValues.addActionOutput();
  const escapingBlock = entryBlock(escapingValues, [
    {
      kind: "if",
      condition,
      thenBody: { actions: [stateRead(escapingOutput, gprChannel("eax"))] }
    },
    finishExit()
  ]);

  throws(
    () => validateIrBlock(escapingBlock, { exportedOutputs: [escapingOutput] }),
    /action output \d+.*does not dominate exported output/
  );
});
