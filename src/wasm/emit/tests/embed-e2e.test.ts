import { strictEqual } from "node:assert";
import { test } from "node:test";

import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { createValueTable, type ValueId } from "#ir/values.js";
import { wasmGuestMemoryMinByteLength } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/emit.js";
import type { CompletionPolicy } from "#wasm/emit/embed.js";
import { decodeExit, ExitReason } from "#wasm/exit.js";
import { readWasmStateChannel, writeWasmCpuState } from "#wasm/state-layout.js";
import { instantiateFunctionBody } from "./harness.js";

// Fragments emitted inline in hand-written function bodies. The fragments
// here are decode reads — a guarded one-byte fetch at eip+k with a
// decode-fault edge — exporting the fetched byte to an embedder local.

type DecodeReadFragment = Readonly<{
  block: IrBlock;
  fetched: ValueId;
}>;

// The fault edge restores eip, leaving the faulting instruction's address
// visible.
function decodeReadFragment(k: number): DecodeReadFragment {
  const values = createValueTable();
  const eipValue = values.addActionOutput();
  const address = values.internBinary("add", eipValue, values.internConst(k));
  const fetched = values.addActionOutput();
  const block: IrBlock = {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "readState", output: eipValue, slot: eipChannel },
          { kind: "guardMemory", address, byteLength: 1, access: "read", faultEdge: 1 },
          { kind: "readMemory", output: fetched, address, width: 8 },
          { kind: "continue" }
        ]
      },
      {
        id: 1,
        kind: "edge",
        flushes: [{ kind: "writeState", slot: eipChannel, value: eipValue }],
        terminator: { kind: "exit", reason: "decodeFault" }
      }
    ],
    values
  };

  return { block, fetched };
}

// The fetched byte widened to the run export's i64 result.
async function instantiateDecodeRead(completion: CompletionPolicy) {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const fetchedLocal = scratch.allocLocal(wasmValueType.i32);
  const fragment = decodeReadFragment(2);

  emitActionFragment(fragment.block, {
    body,
    scratch,
    embedding: { completion, outputs: new Map([[fragment.fetched, fetchedLocal]]) }
  });
  body.localGet(fetchedLocal).i64ExtendI32U().end();
  scratch.freeLocal(fetchedLocal);
  scratch.assertClear();
  return instantiateFunctionBody(body);
}

test("a decode-read fragment exports the byte and its continue falls through", async () => {
  const { stateView, guestView, run } = await instantiateDecodeRead({ kind: "fallthrough" });

  writeWasmCpuState(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x90);

  strictEqual(run(), 0x90n);
});

test("the decode-fault edge keeps the encoded return", async () => {
  const { stateView, run } = await instantiateDecodeRead({ kind: "fallthrough" });
  const eip = wasmGuestMemoryMinByteLength - 2;

  writeWasmCpuState(stateView, { eip });

  const decoded = decodeExit(run());

  strictEqual(decoded.exitReason, ExitReason.DECODE_FAULT);
  strictEqual(decoded.detail, 1);
  strictEqual(readWasmStateChannel(stateView, eipChannel), eip);
});

test("a br continue lands on the embedder label across the fragment's nesting", async () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const fetchedLocal = scratch.allocLocal(wasmValueType.i32);
  const fragment = decodeReadFragment(2);

  body.block();
  emitActionFragment(fragment.block, {
    body,
    scratch,
    embedding: {
      completion: { kind: "br", depth: 0 },
      outputs: new Map([[fragment.fetched, fetchedLocal]])
    }
  });
  body.endBlock();
  body.localGet(fetchedLocal).i64ExtendI32U().end();
  scratch.freeLocal(fetchedLocal);
  scratch.assertClear();

  const { stateView, guestView, run } = await instantiateFunctionBody(body);

  writeWasmCpuState(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x90);
  strictEqual(run(), 0x90n);

  writeWasmCpuState(stateView, { eip: wasmGuestMemoryMinByteLength - 2 });
  strictEqual(decodeExit(run()).exitReason, ExitReason.DECODE_FAULT);
});

test("consecutive fragments share the embedder's scratch locals", async () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const firstLocal = scratch.allocLocal(wasmValueType.i32);
  const secondLocal = scratch.allocLocal(wasmValueType.i32);
  const first = decodeReadFragment(2);
  const second = decodeReadFragment(3);
  const embedFragment = (fragment: DecodeReadFragment, local: number): void => {
    emitActionFragment(fragment.block, {
      body,
      scratch,
      embedding: {
        completion: { kind: "fallthrough" },
        outputs: new Map([[fragment.fetched, local]])
      }
    });
  };

  embedFragment(first, firstLocal);
  embedFragment(second, secondLocal);
  body
    .localGet(secondLocal)
    .i32Const(8)
    .i32Shl()
    .localGet(firstLocal)
    .i32Or()
    .i64ExtendI32U()
    .end();
  scratch.freeLocal(secondLocal);
  scratch.freeLocal(firstLocal);
  scratch.assertClear();

  const { stateView, guestView, run } = await instantiateFunctionBody(body);

  writeWasmCpuState(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x34);
  guestView.setUint8(0x13, 0x12);

  strictEqual(run(), 0x1234n);
});

test("an exported register read pins across a later overlapping store", async () => {
  const values = createValueTable();
  const readValue = values.addActionOutput();
  const incremented = values.internBinary("add", readValue, values.internConst(1));
  const block: IrBlock = {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "readState", output: readValue, slot: gprChannel("eax") },
          { kind: "writeState", slot: gprChannel("eax"), value: incremented },
          { kind: "continue" }
        ]
      }
    ],
    values
  };
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const readLocal = scratch.allocLocal(wasmValueType.i32);

  emitActionFragment(block, {
    body,
    scratch,
    embedding: {
      completion: { kind: "fallthrough" },
      outputs: new Map([[readValue, readLocal]])
    }
  });
  body.localGet(readLocal).i64ExtendI32U().end();
  scratch.freeLocal(readLocal);
  scratch.assertClear();

  const { stateView, run } = await instantiateFunctionBody(body);

  writeWasmCpuState(stateView, { eax: 5 });

  strictEqual(run(), 5n);
  strictEqual(readWasmStateChannel(stateView, gprChannel("eax")), 6);
});
