import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { eipChannel, gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { fitsUnsigned, ValueTable, type ValueId } from "#ir/values.js";
import { wasmGuestMemoryMinByteLength } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import { emitActionFragment } from "#wasm/emit/emit.js";
import type { FallthroughTarget } from "#wasm/emit/embed.js";
import { HostExit, decodeExit, type DecodedExit, type DecodedHostExit } from "#wasm/exit.js";
import { readWasmCpuStateChannel, writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { instantiateFunctionBody } from "./harness.js";
import { memoryCheck, memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

// Fragments emitted inline in hand-written function bodies. The fragments
// here are decode reads — a guarded one-byte fetch at eip+k with a
// decode-fault edge — exporting the fetched byte to an embedder local.

type DecodeReadFragment = Readonly<{
  block: IrBlock;
  fetched: ValueId;
}>;

function dispatchFragment(targetEip: number): IrBlock {
  const values = new ValueTable();
  const target = values.const(targetEip);

  return {
    body: {
      actions: [
        stateWrite(eipChannel, target),
        { kind: "finish", finish: { kind: "dispatch", targetEip: target } }
      ]
    },
    values
  };
}

// The fault edge restores eip, leaving the faulting instruction's address
// visible.
function decodeReadFragment(k: number): DecodeReadFragment {
  const values = new ValueTable();
  const eipValue = values.addActionOutput();
  const address = values.binary("add", eipValue, values.const(k));
  const fault = values.addActionOutput(fitsUnsigned(1));
  const fetched = values.addActionOutput(fitsUnsigned(8));
  const block: IrBlock = {
    body: {
      actions: [
        stateRead(eipValue, eipChannel),
        memoryCheck(fault, address, 1, "read"),
        {
          kind: "if",
          condition: fault,
          hint: "unlikely",
          thenBody: {
            actions: [
              stateWrite(eipChannel, eipValue),
              { kind: "finish", finish: { kind: "exit", reason: "decodeFault", payload: address, detail: 1 } }
            ]
          }
        },
        memoryRead(fetched, address, 8)
      ]
    },
    values
  };

  return { block, fetched };
}

// The fetched byte widened to the run export's i64 result.
async function instantiateDecodeRead(fallthrough: FallthroughTarget) {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const fetchedLocal = scratch.allocLocal(wasmValueType.i32);
  const fragment = decodeReadFragment(2);

  emitActionFragment(fragment.block, {
    body,
    scratch,
    embedding: { fallthrough, outputs: new Map([[fragment.fetched, fetchedLocal]]) }
  });
  body.localGet(fetchedLocal).i64ExtendI32U().end();
  scratch.freeLocal(fetchedLocal);
  scratch.assertClear();
  return instantiateFunctionBody(body);
}

function assertHostExit(exit: DecodedExit, reason: HostExit): asserts exit is DecodedHostExit {
  strictEqual(exit.family, "host");

  if (exit.family !== "host") {
    throw new Error("expected host exit");
  }

  strictEqual(exit.reason, reason);
}

test("a decode-read fragment exports the byte and falls through implicitly", async () => {
  const { stateView, guestView, run } = await instantiateDecodeRead({ kind: "fallthrough" });

  writeWasmCpuStateSnapshot(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x90);

  strictEqual(run(), 0x90n);
});

test("a dispatching fragment requires a dispatch embedding", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);

  throws(
    () =>
      emitActionFragment(dispatchFragment(0x20), {
        body,
        scratch,
        embedding: {}
      }),
    /dispatch action requires embedding\.dispatch/
  );
  scratch.assertClear();
});

test("dispatch br target skips later enclosing harness-style actions", async () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);

  body.block();
  emitActionFragment(dispatchFragment(0x20), {
    body,
    scratch,
    embedding: {
      dispatch: { kind: "br", depth: 0 },
      fallthrough: { kind: "fallthrough" }
    }
  });
  body.i64Const(0x41n).returnFromFunction();
  body.endBlock();
  body.i64Const(0x42n).end();
  scratch.assertClear();

  const { run } = await instantiateFunctionBody(body);

  strictEqual(run(), 0x42n);
});

test("the decode-fault edge keeps the encoded return", async () => {
  const { stateView, run } = await instantiateDecodeRead({ kind: "fallthrough" });
  const eip = wasmGuestMemoryMinByteLength - 2;

  writeWasmCpuStateSnapshot(stateView, { eip });

  const decoded = decodeExit(run());

  assertHostExit(decoded, HostExit.DECODE_FAULT);
  strictEqual(decoded.payload, eip + 2);
  strictEqual(decoded.detail, 1);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), eip);
});

test("fallthrough br target lands on the embedder label across the fragment's nesting", async () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const fetchedLocal = scratch.allocLocal(wasmValueType.i32);
  const fragment = decodeReadFragment(2);

  body.block();
  emitActionFragment(fragment.block, {
    body,
    scratch,
    embedding: {
      fallthrough: { kind: "br", depth: 0 },
      outputs: new Map([[fragment.fetched, fetchedLocal]])
    }
  });
  body.endBlock();
  body.localGet(fetchedLocal).i64ExtendI32U().end();
  scratch.freeLocal(fetchedLocal);
  scratch.assertClear();

  const { stateView, guestView, run } = await instantiateFunctionBody(body);

  writeWasmCpuStateSnapshot(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x90);
  strictEqual(run(), 0x90n);

  writeWasmCpuStateSnapshot(stateView, { eip: wasmGuestMemoryMinByteLength - 2 });
  assertHostExit(decodeExit(run()), HostExit.DECODE_FAULT);
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
        fallthrough: { kind: "fallthrough" },
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

  writeWasmCpuStateSnapshot(stateView, { eip: 0x10 });
  guestView.setUint8(0x12, 0x34);
  guestView.setUint8(0x13, 0x12);

  strictEqual(run(), 0x1234n);
});

test("an exported register read pins across a later overlapping store", async () => {
  const values = new ValueTable();
  const readValue = values.addActionOutput();
  const incremented = values.binary("add", readValue, values.const(1));
  const block: IrBlock = {
    body: {
      actions: [
        stateRead(readValue, gprChannel("eax")),
        stateWrite(gprChannel("eax"), incremented)
      ]
    },
    values
  };
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const readLocal = scratch.allocLocal(wasmValueType.i32);

  emitActionFragment(block, {
    body,
    scratch,
    embedding: {
      fallthrough: { kind: "fallthrough" },
      outputs: new Map([[readValue, readLocal]])
    }
  });
  body.localGet(readLocal).i64ExtendI32U().end();
  scratch.freeLocal(readLocal);
  scratch.assertClear();

  const { stateView, run } = await instantiateFunctionBody(body);

  writeWasmCpuStateSnapshot(stateView, { eax: 5 });

  strictEqual(run(), 5n);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 6);
});
