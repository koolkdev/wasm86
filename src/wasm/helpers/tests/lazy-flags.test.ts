import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { wasmImport } from "#wasm/abi.js";
import { LAZY_FLAGS_KIND } from "#core/flags/state.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import {
  encodeLazyFlagHelperBody
} from "#wasm/helpers/lazy-flags.js";
import { lazyFlagHelperName } from "#wasm/helpers/key.js";
import {
  allHelpers,
  helperFunctionType,
  installHelpers,
  orderedHelpers
} from "#wasm/helpers/module.js";
import { writeWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import { x86StatusFlags, type X86StatusFlag } from "#core/flags/definitions.js";
import type { OperandWidth } from "#core/types.js";
import { aluReference } from "#wasm/emit/tests/reference.js";
import { extractOnlyWasmFunctionBody, wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";

test("lazy flag helper names are stable", () => {
  strictEqual(lazyFlagHelperName("CF"), "resolveCF");
  strictEqual(lazyFlagHelperName("ZF"), "resolveZF");
});

test("lazy flag helper selection deduplicates requested factories", () => {
  const selected = orderedHelpers([
    { kind: "lazyFlag", flag: "ZF" },
    { kind: "lazyFlag", flag: "CF" },
    { kind: "lazyFlag", flag: "ZF" }
  ]);

  strictEqual(selected.length, 2);
  deepStrictEqual(
    new Set(selected.map((helper) => lazyFlagHelperName(helper.flag))),
    new Set([lazyFlagHelperName("CF"), lazyFlagHelperName("ZF")])
  );
});

test("encoded lazy flag helper factories compile", async () => {
  const module = moduleWithCpuMemory();
  const typeIndex = module.addFunctionType(helperFunctionType);

  module.addFunction(typeIndex, encodeLazyFlagHelperBody("ZF"));

  await WebAssembly.compile(module.encode());
});

test("lazy flag helper dispatches through br_table", () => {
  const module = moduleWithCpuMemory();

  installHelpers(module, [{ kind: "lazyFlag", flag: "CF" }]);

  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(module.encode()));

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Eq), false);
});

test("LOGIC arms read only the lazy A channel", () => {
  const module = moduleWithCpuMemory();

  installHelpers(module, [{ kind: "lazyFlag", flag: "ZF" }]);

  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(module.encode()));
  const loads = opcodes.filter(
    (opcode) =>
      opcode === wasmOpcode.i32Load ||
      opcode === wasmOpcode.i32Load8U ||
      opcode === wasmOpcode.i32Load16U
  );

  // One kind-channel read, one NONE flag byte, two lazy operands per
  // ADD/SUB arm, and exactly one — lazyFlagsA — per LOGIC arm.
  strictEqual(loads.length, 1 + 1 + 6 * 2 + 3 * 1);
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
    lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0),
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
      lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, entry.width),
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
      lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.ADD, entry.width),
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

test("lazy flag helpers resolve seeded LOGIC_RESULT runtime state", async () => {
  const runtime = await instantiateLazyFlagHelpers();
  const cases: ReadonlyArray<Readonly<{ width: OperandWidth; result: number }>> = [
    { width: 8, result: 0x00 },
    { width: 8, result: 0x80 },
    { width: 16, result: 0x8000 },
    { width: 16, result: 0x1234 },
    { width: 32, result: 0x8000_0000 },
    { width: 32, result: 0x1234_5678 }
  ];

  for (const entry of cases) {
    writeWasmCpuStateSnapshot(runtime.stateView, {
      lazyFlagsKind: lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, entry.width),
      lazyFlagsA: entry.result,
      lazyFlagsB: 0xffff_ffff,
      CF: 1,
      PF: 0,
      AF: 1,
      ZF: 1,
      SF: 0,
      OF: 1
    });

    const expected = aluReference("or", entry.width, entry.result, 0).flags;

    for (const flag of x86StatusFlags) {
      strictEqual(
        runtime.resolve(flag),
        expected[flag],
        `${entry.width}-bit logic result ${entry.result.toString(16)} ${flag}`
      );
    }
  }
});

test("lazy flag helpers trap on unsupported runtime metadata", async () => {
  const runtime = await instantiateLazyFlagHelpers();

  writeWasmCpuStateSnapshot(runtime.stateView, {
    lazyFlagsKind: 0xff,
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
  const registry = installHelpers(module, allHelpers());

  for (const flag of x86StatusFlags) {
    const helper = { kind: "lazyFlag", flag } as const;
    const functionIndex = registry.functionIndex(helper);

    ok(functionIndex !== undefined, `missing ${lazyFlagHelperName(flag)} helper index`);
    module.exportFunction(lazyFlagHelperName(flag), functionIndex);
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
