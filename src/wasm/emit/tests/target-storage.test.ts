import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { registerAlias } from "#x86/registers.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { wasmOpcode } from "#wasm/encoder/types.js";
import {
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes
} from "#wasm/tests/body-opcodes.js";
import { createWasmSourceReader } from "#wasm/emit/sources/storage.js";
import { stateAluFlagsPlacement } from "#wasm/emit/state/placement.js";
import { createLocalFlagTargetStorage } from "#wasm/emit/targets/locals/flags.js";
import { createLocalRegisterTargetStorage } from "#wasm/emit/targets/locals/registers.js";
import { createStateMemoryFlagTargetStorage } from "#wasm/emit/targets/memory/flags.js";
import { createStateMemoryRegisterTargetStorage } from "#wasm/emit/targets/memory/registers.js";
import { createWasmTargetStorage } from "#wasm/emit/targets/storage.js";
import {
  wasmI32,
  type WasmEmittedValue
} from "#wasm/emit/values/types.js";
import { WASM_STATE_OFFSETS } from "#wasm/state-layout.js";

test("register local storage loads and stores only full 32-bit base registers", () => {
  const body = new RecordingBody();
  const storage = createLocalRegisterTargetStorage(body, registerLocals());

  deepStrictEqual(
    storage.emitLoad({ kind: "reg", reg: registerAlias("eax") }),
    wasmI32(32)
  );
  storage.emitStore({ kind: "reg", reg: registerAlias("eax") }, constValue(body, 0x1234_5678));

  deepStrictEqual(body.ops, [
    { kind: "get", local: 0 },
    { kind: "const", value: 0x1234_5678 },
    { kind: "set", local: 0 }
  ]);
});

test("register local storage rejects partial aliases without emitting instructions", () => {
  const aliases = ["al", "ah", "ax"] as const;

  for (const alias of aliases) {
    const body = new RecordingBody();
    const storage = createLocalRegisterTargetStorage(body, registerLocals());
    const target = { kind: "reg", reg: registerAlias(alias) } as const;

    throws(
      () => storage.emitLoad(target),
      new RegExp(`full 32-bit base register target, got ${alias}`)
    );
    throws(
      () => storage.emitStore(target, constValue(body, 1)),
      new RegExp(`full 32-bit base register target, got ${alias}`)
    );
    deepStrictEqual(body.ops, []);
  }
});

test("state-memory register storage honors partial aliases", () => {
  const body = new WasmFunctionBodyEncoder();
  const storage = createStateMemoryRegisterTargetStorage(body);

  storage.emitLoad({ kind: "reg", reg: registerAlias("ah") });
  storage.emitLoad({ kind: "reg", reg: registerAlias("ax") });
  storage.emitLoad({ kind: "reg", reg: registerAlias("eax") });
  storage.emitStore({ kind: "reg", reg: registerAlias("ah") }, constValue(body, 0x56));
  storage.emitStore({ kind: "reg", reg: registerAlias("ax") }, constValue(body, 0x1234));
  storage.emitStore({ kind: "reg", reg: registerAlias("eax") }, constValue(body, 0x1234_5678));
  body.end();

  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [
    { opcode: wasmOpcode.i32Load8U, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax + 1 },
    { opcode: wasmOpcode.i32Load16U, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax },
    { opcode: wasmOpcode.i32Load, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax },
    { opcode: wasmOpcode.i32Store8, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax + 1 },
    { opcode: wasmOpcode.i32Store16, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax },
    { opcode: wasmOpcode.i32Store, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.eax }
  ]);
});

test("flag local storage loads packed flags and masks stored values to booleans", () => {
  const body = new RecordingBody();
  const storage = createLocalFlagTargetStorage(body, 9);

  storage.emitLoad({ kind: "flag", flag: "ZF" });
  storage.emitStore({ kind: "flag", flag: "ZF" }, constValue(body, 99));

  deepStrictEqual(body.ops, [
    { kind: "get", local: 9 },
    { kind: "const", value: 3 },
    { kind: "shr_u" },
    { kind: "const", value: 1 },
    { kind: "and" },
    { kind: "get", local: 9 },
    { kind: "const", value: 55 },
    { kind: "and" },
    { kind: "const", value: 99 },
    { kind: "eqz" },
    { kind: "eqz" },
    { kind: "const", value: 3 },
    { kind: "shl" },
    { kind: "or" },
    { kind: "set", local: 9 }
  ]);
});

test("state-memory flag storage updates packed aluFlags in state memory", () => {
  const body = new WasmFunctionBodyEncoder();
  const storage = createStateMemoryFlagTargetStorage(body);

  storage.emitStore({ kind: "flag", flag: "OF" }, constValue(body, 2));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [
    { opcode: wasmOpcode.i32Load, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.aluFlags },
    { opcode: wasmOpcode.i32Store, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.aluFlags }
  ]);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Eqz).length, 2);
});

test("source reader placements can mix local registers with state-backed flags", () => {
  const body = new RecordingBody();
  const sources = createWasmSourceReader(body, {
    placement: (source) => {
      switch (source.kind) {
        case "reg":
          return { kind: "local.i32", local: 6 };
        case "flag":
          return { kind: "packed-flag-state", state: stateAluFlagsPlacement() };
      }
    }
  });

  deepStrictEqual(sources.emitInput({ kind: "reg", reg: "eax" }), wasmI32(32));
  deepStrictEqual(sources.emitInput({ kind: "flag", flag: "ZF" }), wasmI32(8));
  body.end();

  deepStrictEqual(body.ops, [
    { kind: "get", local: 6 },
    { kind: "const", value: 0 },
    { kind: "const", value: 3 },
    { kind: "shr_u" },
    { kind: "const", value: 1 },
    { kind: "and" }
  ]);
  deepStrictEqual(wasmBodyMemoryAccesses(body.encode()), [
    { opcode: wasmOpcode.i32Load, memoryIndex: wasmMemoryIndex.state, offset: WASM_STATE_OFFSETS.aluFlags }
  ]);
});

test("target storage dispatch stores local-backed register and flag values directly", () => {
  const body = new RecordingBody();
  const storage = createWasmTargetStorage({
    registers: createLocalRegisterTargetStorage(body, registerLocals()),
    flags: createLocalFlagTargetStorage(body, 8)
  });

  storage.emitStore({ kind: "reg", reg: registerAlias("eax") }, constValue(body, 1));
  storage.emitStore({ kind: "flag", flag: "CF" }, constValue(body, 2));

  deepStrictEqual(body.ops, [
    { kind: "const", value: 1 },
    { kind: "set", local: 0 },
    { kind: "get", local: 8 },
    { kind: "const", value: 62 },
    { kind: "and" },
    { kind: "const", value: 2 },
    { kind: "eqz" },
    { kind: "eqz" },
    { kind: "const", value: 0 },
    { kind: "shl" },
    { kind: "or" },
    { kind: "set", local: 8 }
  ]);
});

test("target storage dispatch fails clearly for unsupported targets", () => {
  const body = new RecordingBody();
  const storage = createWasmTargetStorage({
    registers: createLocalRegisterTargetStorage(body, registerLocals()),
    flags: createLocalFlagTargetStorage(body, 8)
  });
  const target = { kind: "memory" } as unknown as Parameters<typeof storage.emitLoad>[0];

  throws(
    () => storage.emitLoad(target),
    /unsupported StateTarget kind: memory/
  );
  throws(
    () => storage.emitStore(target, constValue(body, 0)),
    /unsupported StateTarget kind: memory/
  );
});

type RecordedOp =
  | Readonly<{ kind: "get"; local: number }>
  | Readonly<{ kind: "set"; local: number }>
  | Readonly<{ kind: "const"; value: number }>
  | Readonly<{ kind: "and" }>
  | Readonly<{ kind: "or" }>
  | Readonly<{ kind: "shl" }>
  | Readonly<{ kind: "shr_u" }>
  | Readonly<{ kind: "eqz" }>;

class RecordingBody extends WasmFunctionBodyEncoder {
  readonly ops: RecordedOp[] = [];

  override localGet(index: number): this {
    super.localGet(index);
    this.ops.push({ kind: "get", local: index });
    return this;
  }

  override localSet(index: number): this {
    super.localSet(index);
    this.ops.push({ kind: "set", local: index });
    return this;
  }

  override i32Const(value: number): this {
    super.i32Const(value);
    this.ops.push({ kind: "const", value });
    return this;
  }

  override i32And(): this {
    super.i32And();
    this.ops.push({ kind: "and" });
    return this;
  }

  override i32Or(): this {
    super.i32Or();
    this.ops.push({ kind: "or" });
    return this;
  }

  override i32Shl(): this {
    super.i32Shl();
    this.ops.push({ kind: "shl" });
    return this;
  }

  override i32ShrU(): this {
    super.i32ShrU();
    this.ops.push({ kind: "shr_u" });
    return this;
  }

  override i32Eqz(): this {
    super.i32Eqz();
    this.ops.push({ kind: "eqz" });
    return this;
  }
}

function registerLocals(): Readonly<Record<Reg32, number>> {
  return Object.freeze(Object.fromEntries(
    reg32.map((reg, index) => [reg, index])
  ) as Record<Reg32, number>);
}

function constValue(body: WasmFunctionBodyEncoder, value: number): () => WasmEmittedValue {
  return () => {
    body.i32Const(value);
    return wasmI32(32);
  };
}
