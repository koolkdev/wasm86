import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
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

function finishExit(reason: "unsupported" | "memoryReadFault" = "unsupported"): Action {
  return { kind: "finish", finish: { kind: "exit", reason } };
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

test("a guard fault body must complete", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "guardMemory",
            address: 0,
            byteLength: 4,
            access: "read",
            faultBody: { actions: [stateWrite(gprChannel("eax"), 0)] }
          },
          writeEip0,
          finishDispatch0
        ])
      ),
    /guardMemory\[0\]\.faultBody does not complete/
  );
});

test("a guard fault body must terminate with an exit", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "guardMemory",
            address: 0,
            byteLength: 4,
            access: "read",
            faultBody: { actions: [writeEip1, finishDispatch(1)] }
          },
          writeEip0,
          finishDispatch0
        ])
      ),
    /guardMemory\[0\]\.faultBody must terminate with exit/
  );
});

test("a guard fault body exit detail must match its byte length", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            kind: "guardMemory",
            address: 0,
            byteLength: 4,
            access: "read",
            faultBody: { actions: [{ kind: "finish", finish: { kind: "exit", reason: "memoryReadFault", detail: 2 } }] }
          },
          writeEip0,
          finishDispatch0
        ])
      ),
    /guardMemory\[0\]\.faultBody exit detail must match guard byte length/
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
