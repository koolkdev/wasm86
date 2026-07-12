import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  WasmFunctionBodyEncoder,
  type WasmFunctionReferences
} from "#compiler/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import { wasmValueType } from "#compiler/encoder/types.js";

test("direct and indirect calls record their module index spaces", () => {
  const references = new WasmFunctionBodyEncoder()
    .callFunction(3)
    .returnCallFunction(5)
    .callIndirect(7, 11)
    .returnCallIndirect(13, 17)
    .finish()
    .references;

  deepStrictEqual(references, {
    functionIndices: [3, 5],
    typeIndices: [7, 13],
    globalIndices: [],
    tableIndices: [11, 17],
    memoryIndices: []
  });
});

test("global instructions record global indexes", () => {
  const references = new WasmFunctionBodyEncoder()
    .globalGet(19)
    .globalSet(23)
    .finish()
    .references;

  deepStrictEqual(references, {
    functionIndices: [],
    typeIndices: [],
    globalIndices: [19, 23],
    tableIndices: [],
    memoryIndices: []
  });
});

test("every memory instruction records its memory index including memory zero", () => {
  const references = new WasmFunctionBodyEncoder()
    .i32Load(memoryImmediate(0))
    .i32Load8S(memoryImmediate(1))
    .i32Load8U(memoryImmediate(2))
    .i32Load16S(memoryImmediate(3))
    .i32Load16U(memoryImmediate(4))
    .i32Store(memoryImmediate(5))
    .i32Store8(memoryImmediate(6))
    .i32Store16(memoryImmediate(7))
    .memorySize(8)
    .finish()
    .references;

  deepStrictEqual(references, {
    functionIndices: [],
    typeIndices: [],
    globalIndices: [],
    tableIndices: [],
    memoryIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8]
  });
});

test("function-local indexes and label depths are not module references", () => {
  const body = new WasmFunctionBodyEncoder(1);
  const local = body.addLocal(wasmValueType.i32);
  const references = body
    .localGet(0)
    .localSet(local)
    .localTee(local)
    .block(wasmValueType.i32)
    .loop()
    .ifBlock({ result: wasmValueType.i32 })
    .br(0)
    .brIf(1)
    .brTable([0, 1], 2)
    .endBlock()
    .endBlock()
    .endBlock()
    .finish()
    .references;

  deepStrictEqual(references, emptyReferences());
});

test("repeated module indexes are reported once in first-use order", () => {
  const references = new WasmFunctionBodyEncoder()
    .callFunction(3)
    .returnCallFunction(3)
    .callIndirect(5, 7)
    .returnCallIndirect(5, 7)
    .globalGet(11)
    .globalSet(11)
    .i32Load(memoryImmediate(13))
    .i32Store(memoryImmediate(13))
    .memorySize(13)
    .finish()
    .references;

  deepStrictEqual(references, {
    functionIndices: [3],
    typeIndices: [5],
    globalIndices: [11],
    tableIndices: [7],
    memoryIndices: [13]
  });
});

test("encoded body bytes and metadata are defensive snapshots", () => {
  const body = new WasmFunctionBodyEncoder()
    .callFunction(3)
    .finish();
  const originalBytes = body.bytes;

  body.bytes.fill(0);
  (body.references.functionIndices as number[]).push(99);
  (body.branchHints as unknown[]).push({ offset: 0, value: 0 });

  deepStrictEqual(body.bytes, originalBytes);
  deepStrictEqual(body.references.functionIndices, [3]);
  deepStrictEqual(body.branchHints, []);
});

function memoryImmediate(memoryIndex: number): WasmMemoryImmediate {
  return { align: 0, offset: 0, memoryIndex };
}

function emptyReferences(): WasmFunctionReferences {
  return {
    functionIndices: [],
    typeIndices: [],
    globalIndices: [],
    tableIndices: [],
    memoryIndices: []
  };
}
