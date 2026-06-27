import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock, IrRegion } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#ir/values.js";

function blockWith(regions: readonly IrRegion[], entry = 0): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 10; value += 1) {
    values.internConst(value);
  }

  return { entry, regions, values };
}

const dispatch0 = { kind: "dispatch", targetEip: 0 } as const;
const dispatch1 = { kind: "dispatch", targetEip: 1 } as const;
const writeEip0 = { kind: "writeState", slot: eipChannel, value: 0 } as const;
const writeEip1 = { kind: "writeState", slot: eipChannel, value: 1 } as const;
const edgeExit = { kind: "exit", reason: "memoryReadFault" } as const;
const legacyContinue = { kind: "continue" } as unknown as Action;

test("an entry ending with an exit validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([{ id: 0, kind: "entry", actions: [{ kind: "exit", reason: "unsupported" }] }])
    )
  );
});

test("an entry ending with dispatch validates", () => {
  doesNotThrow(() =>
    validateIrBlock(blockWith([{ id: 0, kind: "entry", actions: [writeEip0, dispatch0] }]))
  );
});

test("an implicit fragment entry end validates only when allowed", () => {
  const block = blockWith([
    {
      id: 0,
      kind: "entry",
      actions: [{ kind: "writeState", slot: gprChannel("eax"), value: 0 }]
    }
  ]);

  throws(() => validateIrBlock(block), /does not end with a terminator/);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("region continuation fields are rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [writeEip0, dispatch0],
            continuation: 0
          } as unknown as IrRegion
        ])
      ),
    /continuation fields are no longer supported/
  );
});

test("legacy continue actions are rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([{ id: 0, kind: "entry", actions: [legacyContinue] }])
      ),
    /continue action is no longer supported/
  );
});

test("a branch terminator with both edges targeted once validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        {
          id: 0,
          kind: "entry",
          actions: [
            { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 3 },
            { kind: "branch", condition: 0, taken: 1, notTaken: 2 }
          ]
        },
        { id: 1, kind: "edge", flushes: [writeEip0], terminator: dispatch0 },
        { id: 2, kind: "edge", flushes: [writeEip1], terminator: dispatch1 },
        { id: 3, kind: "edge", flushes: [], terminator: edgeExit }
      ])
    )
  );
});

test("a guard fault edge must exit", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [
              { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
              writeEip0,
              dispatch0
            ]
          },
          { id: 1, kind: "edge", flushes: [writeEip1], terminator: dispatch1 }
        ])
      ),
    /guardMemory fault edge 1 must terminate with exit/
  );
});

test("an action after the exit terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [
              { kind: "exit", reason: "unsupported" },
              { kind: "writeState", slot: eipChannel, value: 0 }
            ]
          }
        ])
      ),
    /continues after its exit terminator/
  );
});

test("an action after a dispatch terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [writeEip0, dispatch0, { kind: "writeState", slot: eipChannel, value: 0 }]
          }
        ])
      ),
    /continues after its dispatch terminator/
  );
});

test("an action after a branch terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "branch", condition: 0, taken: 1, notTaken: 2 }, writeEip0, dispatch0]
          },
          { id: 1, kind: "edge", flushes: [writeEip0], terminator: dispatch0 },
          { id: 2, kind: "edge", flushes: [writeEip1], terminator: dispatch1 }
        ])
      ),
    /continues after its branch terminator/
  );
});

test("an entry that does not end with a terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "writeState", slot: eipChannel, value: 0 }]
          }
        ])
      ),
    /does not end with a terminator/
  );
});

test("dispatch target must be a known value", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([{ id: 0, kind: "entry", actions: [{ kind: "dispatch", targetEip: 99 }] }])
      ),
    /unknown value id 99/
  );
});

test("an entry dispatch target write mismatch is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [
              { kind: "writeState", slot: eipChannel, value: 1 },
              { kind: "writeState", slot: gprChannel("eax"), value: 1 },
              dispatch0
            ]
          }
        ])
      ),
    /dispatch entry EIP flush does not match dispatch\.targetEip/
  );
});

test("a dispatch edge must flush EIP state", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "branch", condition: 0, taken: 1, notTaken: 2 }]
          },
          {
            id: 1,
            kind: "edge",
            flushes: [],
            terminator: dispatch0
          },
          { id: 2, kind: "edge", flushes: [writeEip1], terminator: dispatch1 }
        ])
      ),
    /dispatch edge 1 must flush EIP state/
  );
});

test("a dispatch edge target EIP write mismatch is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "branch", condition: 0, taken: 1, notTaken: 2 }]
          },
          {
            id: 1,
            kind: "edge",
            flushes: [writeEip1],
            terminator: dispatch0
          },
          { id: 2, kind: "edge", flushes: [writeEip1], terminator: dispatch1 }
        ])
      ),
    /dispatch edge 1 EIP flush does not match dispatch\.targetEip/
  );
});

test("a branch targeting a missing edge region is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "branch", condition: 0, taken: 1, notTaken: 9 }]
          },
          { id: 1, kind: "edge", flushes: [writeEip0], terminator: dispatch0 }
        ])
      ),
    /branch targets unknown edge region 9/
  );
});

test("an edge targeted by two guards is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [
              { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
              { kind: "guardMemory", address: 0, byteLength: 4, access: "write", faultEdge: 1 },
              writeEip0,
              dispatch0
            ]
          },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit }
        ])
      ),
    /targeted more than once/
  );
});

test("an edge no entry action targets is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          { id: 0, kind: "entry", actions: [writeEip0, dispatch0] },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit }
        ])
      ),
    /not targeted by any entry action/
  );
});

test("a block whose entry id resolves to no entry region is rejected", () => {
  throws(
    () =>
      validateIrBlock(blockWith([{ id: 1, kind: "entry", actions: [dispatch0] }])),
    /entry region is missing/
  );
});

test("duplicate region ids are rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [
              { kind: "guardMemory", address: 0, byteLength: 4, access: "read", faultEdge: 1 },
              writeEip0,
              dispatch0
            ]
          },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit }
        ])
      ),
    /not unique/
  );
});
