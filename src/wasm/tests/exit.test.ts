import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import {
  CompletionExit,
  decodeExit,
  encodeCompletionExit,
  encodeHostExit,
  HostExit,
  type DecodedExit
} from "#wasm/exit.js";

const fixtures: readonly ExitFixture[] = [
  {
    name: "dynamic_jump_exit_decodes",
    family: "completion",
    reason: CompletionExit.DYNAMIC_JUMP,
    payload: 0x1005
  },
  {
    name: "host_trap_exit_decodes",
    family: "host",
    reason: HostExit.TRAP,
    payload: 0xcd
  },
  {
    name: "unsupported_exit_decodes",
    family: "host",
    reason: HostExit.UNSUPPORTED,
    payload: 0x1000
  },
  {
    name: "decode_fault_exit_decodes",
    family: "host",
    reason: HostExit.DECODE_FAULT,
    payload: 0x1000
  },
  {
    name: "memory_read_fault_exit_decodes",
    family: "host",
    reason: HostExit.MEMORY_READ_FAULT,
    payload: 0x3e
  },
  {
    name: "memory_write_fault_exit_decodes",
    family: "host",
    reason: HostExit.MEMORY_WRITE_FAULT,
    payload: 0x3e
  },
  {
    name: "memory_fault_detail_decodes",
    family: "host",
    reason: HostExit.MEMORY_READ_FAULT,
    payload: 0x3e,
    detail: 2
  },
  {
    name: "high_detail_bit_decodes_through_i64_const",
    family: "host",
    reason: HostExit.MEMORY_READ_FAULT,
    payload: 0x3e,
    detail: 0x8000
  },
  {
    name: "roundtrip_high_payload_bit",
    family: "completion",
    reason: CompletionExit.DYNAMIC_JUMP,
    payload: 0xffff_ffff
  }
];

for (const fixture of fixtures) {
  test(fixture.name, async () => {
    const expected = expectedExit(fixture);
    const encoded = encodeFixture(fixture);
    const wasmEncoded = await runExitResult(encoded);

    deepStrictEqual(decodeExit(encoded), expected);
    strictEqual(wasmEncoded, encoded);
    deepStrictEqual(decodeExit(wasmEncoded), expected);
  });
}

test("decode rejects unknown exit family", () => {
  assertUnknownExit(0xff00n << 32n, /unknown Wasm exit family/);
});

test("decode rejects unknown host subtype", () => {
  assertUnknownExit(0x02ffn << 32n, /unknown Wasm host exit/);
});

test("decode rejects unknown completion subtype", () => {
  assertUnknownExit(0x01ffn << 32n, /unknown Wasm completion exit/);
});

test("decode rejects completion exits with detail bits", () => {
  assertUnknownExit((1n << 48n) | (0x0100n << 32n), /Wasm completion exit detail must be zero/);
});

function assertUnknownExit(value: bigint, message: RegExp): void {
  strictEqual(message.test(thrownMessage(() => decodeExit(value))), true);
}

function thrownMessage(fn: () => void): string {
  try {
    fn();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected decode to throw");
}

async function runExitResult(encoded: bigint): Promise<bigint> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [],
    results: [wasmValueType.i64]
  });
  const body = new WasmFunctionBodyEncoder()
    .i64Const(encoded)
    .end();
  const functionIndex = module.addFunction(typeIndex, body);

  module.exportFunction("exitResult", functionIndex);

  const instance = await WebAssembly.instantiate(await WebAssembly.compile(module.encode()));
  const exitResult = instance.exports.exitResult;

  if (typeof exitResult !== "function") {
    throw new Error("expected exported function 'exitResult'");
  }

  const result: unknown = exitResult();

  if (typeof result !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof result}`);
  }

  return result;
}

function encodeFixture(fixture: ExitFixture): bigint {
  switch (fixture.family) {
    case "completion":
      return encodeCompletionExit(fixture.reason, fixture.payload);
    case "host":
      return encodeHostExit(fixture.reason, fixture.payload, fixture.detail);
  }
}

function expectedExit(fixture: ExitFixture): DecodedExit {
  switch (fixture.family) {
    case "completion":
      return {
        family: fixture.family,
        reason: fixture.reason,
        payload: fixture.payload
      };
    case "host":
      return {
        family: fixture.family,
        reason: fixture.reason,
        payload: fixture.payload,
        ...(fixture.detail === undefined ? {} : { detail: fixture.detail })
      };
  }
}

type ExitFixture = DecodedExit & Readonly<{
  name: string;
}>;
