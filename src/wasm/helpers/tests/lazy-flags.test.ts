import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { wasmImport } from "#wasm/abi.js";
import { WASM_CPU_LAZY_FLAGS_KIND } from "#wasm/cpu-state-layout.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import {
  defineLazyFlagHelper,
  defineLazyFlagHelpers,
  lazyFlagHelperName
} from "#wasm/helpers/lazy-flags.js";
import { createWasmHelperRegistry } from "#wasm/helpers/module.js";
import { writeWasmCpuStateSnapshot } from "#runtime/tests/fixtures/cpu-state.js";
import { x86StatusFlags, type X86StatusFlag } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";
import { aluReference } from "#wasm/emit/tests/reference.js";
import { extractOnlyWasmFunctionBody, wasmBodyOpcodes } from "#wasm/tests/body-opcodes.js";

test("lazy flag helper names are stable", () => {
  strictEqual(lazyFlagHelperName("CF"), "resolveCF");
  strictEqual(lazyFlagHelperName("ZF"), "resolveZF");
});

test("lazy flag helper definitions use status flag order", () => {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  defineLazyFlagHelpers(registry, ["ZF", "CF"]);

  strictEqual(registry.functionIndex({ kind: "lazyFlag", flag: "CF" }), 0);
  strictEqual(registry.functionIndex({ kind: "lazyFlag", flag: "ZF" }), 1);
  deepStrictEqual(registry.helpers(), [
    { kind: "lazyFlag", flag: "CF" },
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});

test("lazy flag helper bodies compile", async () => {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  defineLazyFlagHelper(registry, "ZF");

  await WebAssembly.compile(module.encode());
});

test("lazy flag helper dispatches through br_table", () => {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  defineLazyFlagHelper(registry, "CF");

  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(module.encode()));

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Eq), false);
});

test("lazy flag helpers resolve explicit NONE flag bytes", async () => {
  const runtime = await instantiateLazyFlagHelpers();
  const explicitFlags = {
    CF: 1,
    PF: 0,
    AF: 1,
    ZF: 0,
    SF: 1,
    OF: 0
  } as const satisfies Readonly<Record<X86StatusFlag, number>>;

  writeWasmCpuStateSnapshot(runtime.stateView, {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.NONE, 0),
    ...explicitFlags
  });

  for (const flag of x86StatusFlags) {
    strictEqual(runtime.resolve(flag), explicitFlags[flag], flag);
  }
});

test("lazy flag helpers resolve seeded SUB runtime state", async () => {
  const runtime = await instantiateLazyFlagHelpers();
  const cases: ReadonlyArray<Readonly<{ width: OperandWidth; left: number; right: number }>> = [
    { width: 8, left: 0x00, right: 0x01 },
    { width: 8, left: 0x80, right: 0x01 },
    { width: 16, left: 0x8000, right: 0x0001 },
    { width: 16, left: 0x1234, right: 0x1234 },
    { width: 32, left: 0x8000_0000, right: 0x0000_0001 },
    { width: 32, left: 0x1234_5678, right: 0x8765_4321 }
  ];

  for (const entry of cases) {
    writeWasmCpuStateSnapshot(runtime.stateView, {
      lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.SUB, entry.width),
      lazyFlagsA: entry.left,
      lazyFlagsB: entry.right,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    });

    const expected = aluReference("sub", entry.width, entry.left, entry.right).flags;

    for (const flag of x86StatusFlags) {
      strictEqual(
        runtime.resolve(flag),
        expected[flag],
        `${entry.width}-bit ${entry.left.toString(16)} - ${entry.right.toString(16)} ${flag}`
      );
    }
  }
});

test("lazy flag helpers resolve seeded ADD runtime state", async () => {
  const runtime = await instantiateLazyFlagHelpers();
  const cases: ReadonlyArray<Readonly<{ width: OperandWidth; left: number; right: number }>> = [
    { width: 8, left: 0xff, right: 0x01 },
    { width: 8, left: 0x7f, right: 0x01 },
    { width: 16, left: 0xffff, right: 0x0001 },
    { width: 16, left: 0x7fff, right: 0x0001 },
    { width: 32, left: 0xffff_ffff, right: 0x0000_0001 },
    { width: 32, left: 0x7fff_ffff, right: 0x0000_0001 }
  ];

  for (const entry of cases) {
    writeWasmCpuStateSnapshot(runtime.stateView, {
      lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.ADD, entry.width),
      lazyFlagsA: entry.left,
      lazyFlagsB: entry.right,
      CF: 0,
      PF: 0,
      AF: 0,
      ZF: 0,
      SF: 0,
      OF: 0
    });

    const expected = aluReference("add", entry.width, entry.left, entry.right).flags;

    for (const flag of x86StatusFlags) {
      strictEqual(
        runtime.resolve(flag),
        expected[flag],
        `${entry.width}-bit ${entry.left.toString(16)} + ${entry.right.toString(16)} ${flag}`
      );
    }
  }
});

test("lazy flag helpers trap on unsupported runtime metadata", async () => {
  const runtime = await instantiateLazyFlagHelpers();

  writeWasmCpuStateSnapshot(runtime.stateView, {
    lazyFlagsKind: lazyFlagsKindByte(WASM_CPU_LAZY_FLAGS_KIND.LOGIC_RESULT, 32),
    ZF: 1
  });

  throws(() => runtime.resolve("ZF"), WebAssembly.RuntimeError);
});

function moduleWithCpuMemory(): WasmModuleEncoder {
  const module = new WasmModuleEncoder();

  module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  return module;
}

type LazyFlagRuntime = Readonly<{
  stateView: DataView;
  resolve(flag: X86StatusFlag): number;
}>;

async function instantiateLazyFlagHelpers(): Promise<LazyFlagRuntime> {
  const module = moduleWithCpuMemory();
  const registry = createWasmHelperRegistry(module);

  for (const flag of x86StatusFlags) {
    module.exportFunction(lazyFlagHelperName(flag), defineLazyFlagHelper(registry, flag));
  }

  const cpuState = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()), {
    [wasmImport.namespace]: {
      [wasmImport.cpuStateMemoryName]: cpuState
    }
  });
  const stateView = new DataView(cpuState.buffer);

  return {
    stateView,
    resolve(flag) {
      const resolver = instance.exports[lazyFlagHelperName(flag)];

      ok(typeof resolver === "function", `missing ${lazyFlagHelperName(flag)} export`);
      return (resolver as () => number)();
    }
  };
}
