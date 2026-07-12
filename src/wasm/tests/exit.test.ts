import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import {
  CompletionExit,
  decodeExit,
  encodeCompletionExit,
  encodeCpuExceptionExit,
  encodeHostExit,
  HostExit,
  type DecodedExit
} from "#wasm/exit.js";
import { PageFaultErrorCode, divideError, invalidOpcode, pageFault } from "#core/exceptions.js";

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
    name: "segment_load_exit_decodes",
    family: "host",
    reason: HostExit.SEGMENT_LOAD,
    payload: 0x3_1234
  },
  {
    name: "divide_error_decodes",
    family: "cpuException",
    exception: divideError()
  },
  {
    name: "invalid_opcode_decodes",
    family: "cpuException",
    exception: invalidOpcode()
  },
  {
    name: "page_fault_zero_error_code_decodes",
    family: "cpuException",
    exception: pageFault(0x3e, 0)
  },
  {
    name: "page_fault_write_error_code_decodes",
    family: "cpuException",
    exception: pageFault(0x3e, PageFaultErrorCode.WRITE)
  },
  {
    name: "page_fault_fetch_error_code_decodes",
    family: "cpuException",
    exception: pageFault(0x1000, PageFaultErrorCode.INSTRUCTION_FETCH)
  },
  {
    name: "high_detail_bit_decodes_through_i64_const",
    family: "cpuException",
    exception: pageFault(0x3e, 0x8000)
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

test("decode rejects unknown CPU exception subtype", () => {
  assertUnknownExit(0x03ffn << 32n, /unknown x86 CPU exception vector/);
});

test("decode rejects divide error exits with payload bits", () => {
  assertUnknownExit((0x0300n << 32n) | 1n, /Wasm CPU exception exit payload must be zero/);
});

test("decode rejects divide error exits with detail bits", () => {
  assertUnknownExit((1n << 48n) | (0x0300n << 32n), /Wasm CPU exception exit detail must be zero/);
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
      return encodeHostExit(fixture.reason, fixture.payload);
    case "cpuException":
      return encodeCpuExceptionExit(fixture.exception);
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
        payload: fixture.payload
      };
    case "cpuException":
      return {
        family: fixture.family,
        exception: fixture.exception
      };
  }
}

type ExitFixture = DecodedExit & Readonly<{
  name: string;
}>;
