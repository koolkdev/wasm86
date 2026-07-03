import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { maxSwitchMatch, type Action, type SwitchAction } from "#ir/actions.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { Body, IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { fitsUnsigned, ValueTable } from "#ir/values.js";
import { stateWrite } from "#ir/tests/storage-op-helpers.js";

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
  return { kind: "finish", finish: { kind: "dispatch", targetEip } };
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
  doesNotThrow(() => validateIrBlock(blockWith([writeEip0, finishDispatch0])));
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
          condition: 0,
          thenBody: { actions: [writeEip0, finishDispatch0] },
          elseBody: { actions: [writeEip1, finishDispatch(1)] }
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
      validateIrBlock(blockWith([writeEip0, finishDispatch0, stateWrite(eipChannel, 0)])),
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
            condition: 0,
            thenBody: { actions: [writeEip0, finishDispatch0] },
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

test("a root dispatch target write mismatch is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          stateWrite(eipChannel, 1),
          stateWrite(gprChannel("eax"), 1),
          finishDispatch0
        ])
      ),
    /body dispatch EIP flush does not match dispatch\.targetEip/
  );
});

test("a nested dispatch can use an ancestor EIP write", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        writeEip0,
        {
          kind: "if",
          condition: 1,
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishExit()] }
        }
      ])
    )
  );
});

test("a nested dispatch must flush EIP state on its path", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "if",
            condition: 0,
            thenBody: { actions: [finishDispatch0] },
            elseBody: { actions: [finishExit()] }
          }
        ])
      ),
    /thenBody dispatch path must flush EIP state/
  );
});

function switchWith(overrides: Partial<SwitchAction>): Action {
  return {
    kind: "switch",
    selector: 0,
    output: 1,
    cases: [
      { match: 0, body: { actions: [], result: 2 } },
      { match: 2, body: { actions: [], result: 3 } }
    ],
    defaultBody: { actions: [], result: 4 },
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
            condition: 0,
            thenBody: { actions: [finishExit()], result: 1 }
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
          switchWith({ cases: [{ match: 0, body: { actions: [finishExit()], result: 2 } }] }),
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
              { match: 1, body: { actions: [], result: 2 } },
              { match: 1, body: { actions: [], result: 3 } }
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
          switchWith({ cases: [{ match: -1, body: { actions: [], result: 2 } }] }),
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
        switchWith({ cases: [{ match: maxSwitchMatch, body: { actions: [], result: 2 } }] }),
        finishExit()
      ])
    )
  );
  throws(
    () =>
      validateIrBlock(
        blockWith([
          switchWith({ cases: [{ match: maxSwitchMatch + 1, body: { actions: [], result: 2 } }] }),
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

test("a nested dispatch target EIP write mismatch is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "if",
            condition: 0,
            thenBody: { actions: [writeEip1, finishDispatch0] },
            elseBody: { actions: [finishExit()] }
          }
        ])
      ),
    /thenBody dispatch EIP flush does not match dispatch\.targetEip/
  );
});
