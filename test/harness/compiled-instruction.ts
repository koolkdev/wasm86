import { ok } from "node:assert";

import type { StorageAccess, StorageEffects } from "#compiler/ir/effects.js";
import { buildVariant } from "#compiler/ir/values/variant.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import {
  exportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import { decodeIsaInstructionFromReader } from "#core/decoder/decode.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeByteResult,
  IsaDecodeReader
} from "#core/decoder/types.js";
import {
  createInstructionBuilder,
  staticInstructionLocation
} from "#core/instruction/builder.js";
import { staticOperandBinding } from "#core/instruction/static-binding.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";
import type { RunStop } from "#cpu/cpu.js";
import {
  buildExit,
  decodeExit,
  exitLayout
} from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStateAccess,
  cpuStatusFlagResolvers
} from "#cpu/state.js";
import { budgetExit } from "#engines/interpreter/exits.js";
import { guestMemoryAccess } from "#memory/access.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { readBackingByte, writeBackingBytes } from "#memory/bytes.js";
import { guestMemoryResource } from "#memory/resource.js";
import { startAddress } from "#test/support/addresses.js";
import {
  readWasmCpuStateSnapshot,
  type WasmCpuStateInit,
  type WasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";

export type CompiledInstructionMemoryPatch = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export type CompiledInstructionMemoryRange = Readonly<{
  address: number;
  byteLength: number;
}>;

export type CompiledInstructionMemorySnapshot = CompiledInstructionMemoryRange & Readonly<{
  bytes: readonly number[];
}>;

export type RunCompiledInstructionsInput = Readonly<{
  bytes: readonly number[];
  initialState?: WasmCpuStateInit;
  memoryPatches?: readonly CompiledInstructionMemoryPatch[];
  memoryRanges?: readonly CompiledInstructionMemoryRange[];
}>;

export type CompiledInstructionCompletion =
  | Exclude<RunStop, Readonly<{ kind: "instructionLimit" }>>
  | Readonly<{ kind: "completed"; targetEip: number }>;

export type CompiledInstructionResult = Readonly<{
  completion: CompiledInstructionCompletion;
  state: WasmCpuStateSnapshot;
  memory: readonly CompiledInstructionMemorySnapshot[];
}>;

export async function runCompiledInstructions(
  input: RunCompiledInstructionsInput
): Promise<CompiledInstructionResult> {
  const instructionAddress = input.initialState?.eip ?? startAddress;
  const instructions = decodeInstructionBytes(input.bytes, instructionAddress);
  const memories = createTestWasmMemories();

  for (const patch of input.memoryPatches ?? []) {
    const faultAddress = writeBackingBytes(memories.guestMemory, patch.address, patch.bytes);

    ok(
      faultAddress === undefined,
      `compiled instruction memory patch is out of bounds at 0x${faultAddress?.toString(16)}`
    );
  }

  const stateView = new DataView(memories.cpuStateMemory.buffer);

  writeWasmCpuStateSnapshot(stateView, {
    ...input.initialState,
    eip: instructionAddress
  });

  ok(instructions.length > 0, "compiled instruction input decoded no instructions");
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(buildInstructionProgram(instructions))),
    {
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: memories.cpuStateMemory,
        [wasmImport.guestMemoryName]: memories.guestMemory
      }
    }
  );
  const entry = instance.exports[wasmBlockExportName];

  ok(typeof entry === "function", "compiled instruction entry export is missing");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", `compiled instruction returned ${typeof encodedExit}, expected bigint`);
  const state = readWasmCpuStateSnapshot(stateView);
  const stop = decodeExit(encodedExit);
  // The local dispatch target uses the budget stop only as its completion
  // sentinel. Core exits reach this point unchanged.
  const completion: CompiledInstructionCompletion = stop.kind === "instructionLimit"
    ? { kind: "completed", targetEip: state.eip }
    : stop;

  return {
    completion,
    state,
    memory: (input.memoryRanges ?? []).map((range) => ({
      ...range,
      bytes: readMemoryRange(memories.guestMemory, range)
    }))
  };
}

function buildInstructionProgram(
  instructions: readonly IsaDecodedInstruction[]
) {
  const program = new ProgramBuilder();
  const entryType = functionType([], ["i64"]);
  const dispatchType = functionType(["i32"], ["i64"]);
  const entrySignature = signatureRef("test.compiled-instruction.entry-signature");
  const dispatchSignature = signatureRef("test.compiled-instruction.dispatch-signature");

  program.signature({ ref: entrySignature, type: entryType });
  program.signature({ ref: dispatchSignature, type: dispatchType });
  program.importMemory({
    ref: cpuState.resource,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  program.importMemory({
    ref: guestMemoryResource,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });

  const dispatch = program.defineFunction({
    ref: functionRef("test.compiled-instruction.dispatch"),
    signature: dispatchSignature,
    effects: noEffects
  }, (fn) => {
    fn.return([buildVariant(fn.values, exitLayout, budgetExit())]);
  });
  const entry = program.defineFunction({
    ref: functionRef("test.compiled-instruction.entry"),
    signature: entrySignature,
    effects: compiledInstructionEffects
  }, (fn) => {
    const builder = createInstructionBuilder(fn.region, {
      stateAccess: cpuStateAccess,
      statusFlagResolvers: cpuStatusFlagResolvers,
      memory: guestMemoryAccess,
      instructionCountField,
      buildExit,
      terminals: instructionFunctionTerminals(dispatch)
    });

    for (const instruction of instructions) {
      if (!builder.add(
        instruction.spec.semantics,
        instruction.operands.map(staticOperandBinding),
        staticInstructionLocation(instruction.address, instruction.nextEip)
      )) {
        break;
      }
    }
    builder.finish();
  });

  program.exportFunction({
    ref: exportRef("test.compiled-instruction.entry-export"),
    name: wasmBlockExportName,
    target: entry.ref
  });
  return program.finish();
}

function instructionFunctionTerminals(
  dispatch: FunctionDefinition
): InstructionTerminals {
  return {
    dispatch: (body, targetEip) => body.returnCall(dispatch, [targetEip]),
    returnExit: (body, result) => body.return([result])
  };
}

const noEffects: StorageEffects = { reads: [], writes: [] };
const wholeCpuState: StorageAccess = {
  space: "resource",
  resource: cpuState.resource,
  range: { basis: { kind: "resource" } }
};
const wholeGuestMemory: StorageAccess = {
  space: "resource",
  resource: guestMemoryResource,
  range: { basis: { kind: "resource" } }
};
const compiledInstructionEffects: StorageEffects = {
  reads: [wholeCpuState, wholeGuestMemory],
  writes: [wholeCpuState, wholeGuestMemory]
};

class FiniteInstructionReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: readonly number[], readonly baseAddress: number) {
    this.#bytes = Uint8Array.from(bytes);
  }

  readU8(address: number): IsaDecodeByteResult {
    const index = address - this.baseAddress;
    const value = this.#bytes[index];

    ok(
      Number.isInteger(index) && index >= 0 && value !== undefined,
      `compiled instruction fixture has no byte at 0x${address.toString(16)}`
    );

    return { kind: "byte", value };
  }
}

function decodeInstructionBytes(
  bytes: readonly number[],
  start: number
): readonly IsaDecodedInstruction[] {
  const reader = new FiniteInstructionReader(bytes, start);
  const instructions: IsaDecodedInstruction[] = [];
  let consumed = 0;
  let address = start;

  while (consumed < bytes.length) {
    const decoded = decodeIsaInstructionFromReader(reader, address);

    ok(
      decoded.kind === "instruction",
      decoded.kind === "cpuException"
        ? `compiled instruction input produced ${decoded.exception.kind}`
        : "compiled instruction input produced an unknown decode result"
    );
    instructions.push(decoded.instruction);
    consumed += decoded.instruction.length;
    address = decoded.instruction.nextEip;
  }

  ok(consumed === bytes.length, "compiled instruction input ended inside a decoded instruction");
  return instructions;
}

function readMemoryRange(
  memory: WebAssembly.Memory,
  range: CompiledInstructionMemoryRange
): readonly number[] {
  ok(
    Number.isInteger(range.byteLength) && range.byteLength >= 0,
    `compiled instruction memory range has invalid byte length: ${range.byteLength}`
  );

  const bytes: number[] = [];

  for (let index = 0; index < range.byteLength; index += 1) {
    const address = range.address + index;
    const value = readBackingByte(memory, address);

    ok(value !== undefined, `compiled instruction memory range is out of bounds at 0x${address.toString(16)}`);
    bytes.push(value);
  }

  return bytes;
}
