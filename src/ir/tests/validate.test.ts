import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { maxSwitchMatch, type Action, type SwitchAction } from "#ir/actions.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { Body, IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { fitsUnsigned, valueId } from "#ir/values.js";
import { ValueTable } from "#ir/value-table.js";
import { stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

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
          {
            kind: "op",
            output: missingBoundsOutput,
            op: { kind: "memory.read", address: missingBoundsAddress, width: 8 }
          },
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
          {
            kind: "op",
            output: overlyNarrowOutput,
            op: { kind: "memory.read", address: overlyNarrowAddress, width: 32 }
          },
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

function switchWith(overrides: Partial<SwitchAction>): Action {
  return {
    kind: "switch",
    selector: valueId(0),
    output: valueId(1),
    cases: [
      { match: 0, body: { actions: [], result: valueId(2) } },
      { match: 2, body: { actions: [], result: valueId(3) } }
    ],
    defaultBody: { actions: [], result: valueId(4) },
    ...overrides
  };
}

test("a switch whose bodies all carry results validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith([switchWith({}), finishExit()])));
});

test("an escaping switch body is rejected until a producer arrives", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({ cases: [{ match: 0, body: { actions: [finishExit()] } }] }),
          finishExit()
        ])
      ),
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
      validateIrBlock(
        blockWith([
          switchWith({ cases: [{ match: 0, body: { actions: [finishExit()], result: valueId(2) } }] }),
          finishExit()
        ])
      ),
    /case\[0\] carries a result but completes/
  );
});

test("an output-owner body that neither escapes nor carries a result is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({ defaultBody: { actions: [] } }),
          finishExit()
        ])
      ),
    /default must carry a result/
  );
});

test("a duplicate switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({
            cases: [
              { match: 1, body: { actions: [], result: valueId(2) } },
              { match: 1, body: { actions: [], result: valueId(3) } }
            ]
          }),
          finishExit()
        ])
      ),
    /has a duplicate case match 1/
  );
});

test("a negative switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({ cases: [{ match: -1, body: { actions: [], result: valueId(2) } }] }),
          finishExit()
        ])
      ),
    /case match -1 is not an integer in \[0, 255\]/
  );
});

test("a switch case match beyond the dense-table bound is rejected", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        switchWith({ cases: [{ match: maxSwitchMatch, body: { actions: [], result: valueId(2) } }] }),
        finishExit()
      ])
    )
  );
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({ cases: [{ match: maxSwitchMatch + 1, body: { actions: [], result: valueId(2) } }] }),
          finishExit()
        ])
      ),
    /case match 256 is not an integer in \[0, 255\]/
  );
});

test("a switch without a default body is rejected", () => {
  const missingDefault = switchWith({ defaultBody: undefined as unknown as Body });

  throws(
    () => validateIrBlock(blockWith([missingDefault, finishExit()])),
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
        blockWith([{ kind: "op", op: { kind: "var.write", variable: -1, value: valueId(0) } }])
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
