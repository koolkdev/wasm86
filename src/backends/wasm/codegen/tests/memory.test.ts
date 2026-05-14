import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmImport, wasmMemoryIndex } from "#backends/wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { decodeExit, ExitReason } from "#backends/wasm/exit.js";
import { emitWasmIrExitFromI32Stack, type WasmIrExitTarget } from "#backends/wasm/codegen/exit.js";
import {
  emitWasmIrGuardGuestRange,
  emitWasmIrLoadGuest,
  emitWasmIrLoadGuestFromStack,
  emitWasmIrLoadGuestU32,
  emitWasmIrLoadGuestU32FromStack,
  emitWasmIrStoreGuest,
  emitWasmIrStoreGuestU32
} from "#backends/wasm/codegen/memory.js";
import type { OperandWidth } from "#x86/isa/types.js";

test("guest u32 load helpers return values and fault before out-of-bounds reads", async () => {
  for (const mode of ["local", "stack"] as const) {
    const { run, guestView } = await instantiateMemoryModule(encodeGuestLoadModule(mode));

    guestView.setUint32(12, 0x1234_5678, true);

    deepStrictEqual(decodeExit(run(12)), {
      exitReason: ExitReason.FALLTHROUGH,
      payload: 0x1234_5678
    });
    deepStrictEqual(decodeExit(run(0x1_0000)), {
      exitReason: ExitReason.MEMORY_READ_FAULT,
      payload: 0x1_0000,
      detail: 4
    });
  }
});

test("guest stack load helper consumes the stack address before loaded value use", async () => {
  const { run, guestView } = await instantiateI32Module(encodeGuestStackLoadConsumedModule());

  guestView.setUint32(12, 0x1234_5678, true);

  strictEqual(run(12), 0x1234_5679);
});

test("guest u32 store helper writes values and reports write faults", async () => {
  const { run, guestView } = await instantiateMemoryModule(encodeGuestStoreModule());

  deepStrictEqual(decodeExit(run(16, 0x89ab_cdef)), {
    exitReason: ExitReason.FALLTHROUGH,
    payload: 0
  });
  strictEqual(guestView.getUint32(16, true), 0x89ab_cdef);

  deepStrictEqual(decodeExit(run(0x1_0000, 0)), {
    exitReason: ExitReason.MEMORY_WRITE_FAULT,
    payload: 0x1_0000,
    detail: 4
  });
});

test("guest width-aware helpers use 1/2/4-byte bounds", async () => {
  for (const width of [8, 16, 32] as const) {
    const byteLength = width / 8;
    const maxValidAddress = 0x1_0000 - byteLength;
    const faultAddress = maxValidAddress + 1;

    for (const mode of ["local", "stack"] as const) {
      const { run, guestView } = await instantiateMemoryModule(encodeGuestLoadModule(mode, width));

      writeGuestValue(guestView, maxValidAddress, width, 0x1234_5678);

      deepStrictEqual(decodeExit(run(maxValidAddress)), {
        exitReason: ExitReason.FALLTHROUGH,
        payload: expectedGuestValue(width, 0x1234_5678)
      });
      deepStrictEqual(decodeExit(run(faultAddress)), {
        exitReason: ExitReason.MEMORY_READ_FAULT,
        payload: faultAddress,
        detail: byteLength
      });
    }

    const { run, guestView } = await instantiateMemoryModule(encodeGuestStoreModule(width));

    writeGuestValue(guestView, maxValidAddress, width, 0xffff_ffff);
    deepStrictEqual(decodeExit(run(maxValidAddress, 0x1234_5678)), {
      exitReason: ExitReason.FALLTHROUGH,
      payload: 0
    });
    strictEqual(readGuestValue(guestView, maxValidAddress, width), expectedGuestValue(width, 0x1234_5678));
    deepStrictEqual(decodeExit(run(faultAddress, 0)), {
      exitReason: ExitReason.MEMORY_WRITE_FAULT,
      payload: faultAddress,
      detail: byteLength
    });
  }
});

test("guest range guard helper uses byte lengths independent of load/store width", async () => {
  const { run } = await instantiateMemoryModule(encodeGuestGuardModule(8, "read"));

  deepStrictEqual(decodeExit(run(0x1_0000 - 8)), {
    exitReason: ExitReason.FALLTHROUGH,
    payload: 0
  });
  deepStrictEqual(decodeExit(run(0x1_0000 - 7)), {
    exitReason: ExitReason.MEMORY_READ_FAULT,
    payload: 0x1_0000 - 7,
    detail: 8
  });
});

async function instantiateMemoryModule(bytes: Uint8Array<ArrayBuffer>): Promise<{
  run: (...args: number[]) => bigint;
  guestView: DataView;
}> {
  const module = await WebAssembly.compile(bytes);
  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const guestMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return {
    run: (...args) => {
      const result = (run as (...callArgs: number[]) => unknown)(...args);

      if (typeof result !== "bigint") {
        throw new Error(`expected bigint result, got ${typeof result}`);
      }

      return result;
    },
    guestView: new DataView(guestMemory.buffer)
  };
}

async function instantiateI32Module(bytes: Uint8Array<ArrayBuffer>): Promise<{
  run: (...args: number[]) => number;
  guestView: DataView;
}> {
  const module = await WebAssembly.compile(bytes);
  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const guestMemory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return {
    run: (...args) => {
      const result = (run as (...callArgs: number[]) => unknown)(...args);

      if (typeof result !== "number") {
        throw new Error(`expected number result, got ${typeof result}`);
      }

      return result;
    },
    guestView: new DataView(guestMemory.buffer)
  };
}

function encodeGuestGuardModule(byteLength: number, access: "read" | "write"): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();

  importStateAndGuestMemory(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder(1);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const exit: WasmIrExitTarget = { exitLocal, exitLabelDepth: 0 };

  body.block();
  emitWasmIrGuardGuestRange({ body, exit }, 0, byteLength, access);
  body.i32Const(0);
  emitWasmIrExitFromI32Stack(body, exit, ExitReason.FALLTHROUGH);
  body.endBlock();
  body.localGet(exitLocal).end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function encodeGuestStackLoadConsumedModule(): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();

  importStateAndGuestMemory(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(1);
  const resultLocal = body.addLocal(wasmValueType.i32);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const exit: WasmIrExitTarget = { exitLocal, exitLabelDepth: 0 };

  body.block();
  body.localGet(0);
  emitWasmIrLoadGuestFromStack({ body, exit }, 0, 32);
  body.i32Const(1).i32Add().localSet(resultLocal);
  body.endBlock();
  body.localGet(resultLocal).end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function encodeGuestLoadModule(mode: "local" | "stack", width: OperandWidth = 32): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();

  importStateAndGuestMemory(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder(1);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const exit: WasmIrExitTarget = { exitLocal, exitLabelDepth: 0 };

  body.block();
  if (mode === "local") {
    if (width === 32) {
      emitWasmIrLoadGuestU32({ body, exit }, 0);
    } else {
      emitWasmIrLoadGuest({ body, exit }, 0, width);
    }
  } else {
    body.localGet(0);
    if (width === 32) {
      emitWasmIrLoadGuestU32FromStack({ body, exit }, 0);
    } else {
      emitWasmIrLoadGuestFromStack({ body, exit }, 0, width);
    }
  }
  emitWasmIrExitFromI32Stack(body, exit, ExitReason.FALLTHROUGH);
  body.endBlock();
  body.localGet(exitLocal).end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function encodeGuestStoreModule(width: OperandWidth = 32): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();

  importStateAndGuestMemory(module);

  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder(2);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const exit: WasmIrExitTarget = { exitLocal, exitLabelDepth: 0 };

  body.block();
  if (width === 32) {
    emitWasmIrStoreGuestU32({ body, exit }, 0, 1);
  } else {
    emitWasmIrStoreGuest({ body, exit }, 0, 1, width);
  }
  body.i32Const(0);
  emitWasmIrExitFromI32Stack(body, exit, ExitReason.FALLTHROUGH);
  body.endBlock();
  body.localGet(exitLocal).end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function writeGuestValue(view: DataView, address: number, width: OperandWidth, value: number): void {
  switch (width) {
    case 8:
      view.setUint8(address, value & 0xff);
      return;
    case 16:
      view.setUint16(address, value & 0xffff, true);
      return;
    case 32:
      view.setUint32(address, value >>> 0, true);
      return;
  }
}

function readGuestValue(view: DataView, address: number, width: OperandWidth): number {
  switch (width) {
    case 8:
      return view.getUint8(address);
    case 16:
      return view.getUint16(address, true);
    case 32:
      return view.getUint32(address, true);
  }
}

function expectedGuestValue(width: OperandWidth, value: number): number {
  switch (width) {
    case 8:
      return value & 0xff;
    case 16:
      return value & 0xffff;
    case 32:
      return value >>> 0;
  }
}

function importStateAndGuestMemory(module: WasmModuleEncoder): void {
  const stateMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, { minPages: 1 });

  if (stateMemoryIndex !== wasmMemoryIndex.state || guestMemoryIndex !== wasmMemoryIndex.guest) {
    throw new Error("unexpected Wasm memory import order");
  }
}
