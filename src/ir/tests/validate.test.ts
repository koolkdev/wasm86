import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { eipChannel } from "#ir/slots.js";
import type { IrBlock, IrRegion } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#ir/values.js";

// Validation checks shape only, so the value table can stay empty and value
// ids are arbitrary.

function blockWith(regions: readonly IrRegion[], entry = 0): IrBlock {
  return { entry, regions, values: new ValueTable() };
}

const continueAction = { kind: "continue" } as const;
const edgeExit = { kind: "exit", reason: "memoryReadFault" } as const;

test("an entry ending with an exit validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([{ id: 0, kind: "entry", actions: [{ kind: "exit", reason: "unsupported" }] }])
    )
  );
});

test("an entry ending with a continue validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        {
          id: 0,
          kind: "entry",
          actions: [{ kind: "writeState", slot: eipChannel, value: 0 }, continueAction],
          continuation: 0
        }
      ])
    )
  );
});

test("a continuation that does not match the flushed eip is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [{ kind: "writeState", slot: eipChannel, value: 0 }, continueAction],
            continuation: 1
          }
        ])
      ),
    /continuation does not match its flushed eip/
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
        { id: 1, kind: "edge", flushes: [], terminator: continueAction },
        { id: 2, kind: "edge", flushes: [], terminator: continueAction },
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
              continueAction
            ]
          },
          { id: 1, kind: "edge", flushes: [], terminator: continueAction }
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

test("an action after a continue terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith([
          {
            id: 0,
            kind: "entry",
            actions: [continueAction, { kind: "writeState", slot: eipChannel, value: 0 }]
          }
        ])
      ),
    /continues after its continue terminator/
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
            actions: [{ kind: "branch", condition: 0, taken: 1, notTaken: 2 }, continueAction]
          },
          { id: 1, kind: "edge", flushes: [], terminator: continueAction },
          { id: 2, kind: "edge", flushes: [], terminator: continueAction }
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
          { id: 1, kind: "edge", flushes: [], terminator: continueAction }
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
              continueAction
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
          { id: 0, kind: "entry", actions: [continueAction] },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit }
        ])
      ),
    /not targeted by any entry action/
  );
});

test("a block whose entry id resolves to no entry region is rejected", () => {
  throws(
    () =>
      validateIrBlock(blockWith([{ id: 1, kind: "entry", actions: [continueAction] }])),
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
              continueAction
            ]
          },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit },
          { id: 1, kind: "edge", flushes: [], terminator: edgeExit }
        ])
      ),
    /not unique/
  );
});
