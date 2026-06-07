import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { BlockExit, BlockExitId } from "#ir/block/exits.js";
import { initialBlockState } from "#ir/block/walk/state.js";
import { opSite } from "#ir/block/walk/site.js";
import { exprConst } from "#ir/expr/builders.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import {
  createWasmExitEmitter,
  createWasmExitRegionContext
} from "#wasm/emit/block/exits.js";
import {
  createWasmLocalExitTarget,
  createWasmReturnExitTarget
} from "#wasm/emit/block/exit-targets.js";
import {
  decodeExit,
  encodeExit,
  ExitReason
} from "#wasm/exit.js";

test("real exit emitter returns encoded host-trap payload", async () => {
  deepStrictEqual(
    decodeExit(await runExit(hostTrapExit(), { payload: 0xcd })),
    { exitReason: ExitReason.HOST_TRAP, payload: 0xcd }
  );
});

test("real exit emitter returns encoded memory-fault payload and byte-length detail", async () => {
  deepStrictEqual(
    decodeExit(await runExit(memoryFaultExit(), { payload: 0x2001 })),
    {
      exitReason: ExitReason.MEMORY_WRITE_FAULT,
      payload: 0x2001,
      detail: 2
    }
  );
});

test("real exit emitter returns encoded fallthrough target when ABI payload is present", async () => {
  deepStrictEqual(
    decodeExit(await runExit(fallthroughExit(), { payload: 0x1010 })),
    { exitReason: ExitReason.FALLTHROUGH, payload: 0x1010 }
  );
});

test("real exit emitter returns a zero payload when no ABI payload exists", async () => {
  deepStrictEqual(
    decodeExit(await runExit(fallthroughExitWithoutTarget())),
    { exitReason: ExitReason.FALLTHROUGH, payload: 0 }
  );
});

test("real exit emitter can write a local and branch out of action control", async () => {
  deepStrictEqual(
    decodeExit(await runLocalExit(hostTrapExit(), 0xcd)),
    { exitReason: ExitReason.HOST_TRAP, payload: 0xcd }
  );
});

async function runExit(
  exit: BlockExit,
  options: Readonly<{ payload?: number }> = {}
): Promise<bigint> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder();
  const exitRegions = createWasmExitRegionContext();
  const emitter = createWasmExitEmitter({
    exitRegions,
    target: createWasmReturnExitTarget(body)
  });

  if (options.payload !== undefined) {
    body.i32Const(options.payload);
    exitRegions.withExitRegion(exit, { kind: "stack" }, () => emitter.emitExit({ exit }));
  } else {
    exitRegions.withExitRegion(exit, { kind: "constant", value: 0 }, () => emitter.emitExit({ exit }));
  }
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("run", functionIndex);

  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()));
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected run export");
  }

  const result: unknown = run();

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof result}`);
  }

  return result;
}

async function runLocalExit(exit: BlockExit, payload: number): Promise<bigint> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder();
  const exitLocal = body.addLocal(wasmValueType.i64);
  const exitRegions = createWasmExitRegionContext();
  const emitter = createWasmExitEmitter({
    exitRegions,
    target: createWasmLocalExitTarget({
      body,
      destination: () => ({ exitLocal, labelDepth: 0 })
    })
  });

  body.block();
  exitRegions.withControlDepth(1, () => {
    body.i32Const(1).ifBlock();
    body.i32Const(payload);
    exitRegions.withExitRegion(exit, { kind: "stack" }, () => emitter.emitExit({ exit }));
    body.endBlock();
  });
  body.i64Const(encodeExit(ExitReason.UNSUPPORTED, 0)).localSet(exitLocal);
  body.endBlock();
  body.localGet(exitLocal).returnFromFunction();
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("run", functionIndex);

  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()));
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected run export");
  }

  const result: unknown = run();

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof result}`);
  }

  return result;
}

function hostTrapExit(): BlockExit {
  return blockExit(0, "hostTrap", {
    kind: "hostTrap",
    vector: exprConst(0xcd)
  });
}

function memoryFaultExit(): BlockExit {
  return blockExit(1, "memoryFault", {
    kind: "memoryFault",
    address: exprConst(0x2001),
    byteLength: 2,
    access: "write"
  });
}

function fallthroughExit(): BlockExit {
  return blockExit(2, "fallthrough", {
    kind: "fallthrough"
  });
}

function fallthroughExitWithoutTarget(): BlockExit {
  return blockExit(3, "fallthrough", {
    kind: "fallthrough"
  });
}

function blockExit(
  id: number,
  kind: BlockExit["kind"],
  payload: BlockExit["payload"]
): BlockExit {
  return Object.freeze({
    id: id as BlockExitId,
    at: opSite(0),
    kind,
    snapshot: initialBlockState(),
    payload
  });
}
