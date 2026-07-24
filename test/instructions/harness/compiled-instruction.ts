import { ok } from "node:assert";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { encodeVariant } from "#compiler/layout/variant-codec.js";
import type { StorageAccess, StorageEffects } from "#compiler/ir/effects.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import { buildVariant } from "#compiler/ir/builder/variant.js";
import { compileProgram } from "#compiler/compile.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/ir/refs.js";
import { decodeIsaInstructionFromReader } from "#instructions/decoder/decode.js";
import type {
  IsaDecodedInstruction,
  IsaDecodeReadResult,
  IsaDecodeReader
} from "#instructions/decoder/types.js";
import {
  x86StatusFlags,
  type X86StatusFlag
} from "#core/flags/definitions.js";
import {
  staticInstructionLocation
} from "#instructions/lowering/builder.js";
import {
  createInstructionLowerer
} from "#instructions/lowering/lowerer.js";
import { staticOperandBinding } from "#instructions/lowering/static-binding.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import type { RunStop } from "#cpu/cpu.js";
import { createCpuStateHostView } from "#cpu/host-view.js";
import {
  buildExit,
  decodeExit,
  exitLayout
} from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStateAccess,
  guestMemoryAccess,
  testExecutionModel
} from "#test/support/execution-model.js";
import { instructionLimitExit } from "#interpreter/exits.js";
import { readBackingByte, writeBackingBytes } from "#memory/bytes.js";
import { startAddress } from "#test/support/addresses.js";
import {
  readWasmCpuStateSnapshot,
  wasmCpuArchitecturalStateOf,
  type WasmCpuArchitecturalStateInit,
  type WasmCpuArchitecturalStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

const compiledInstructionExport = functionExportRef(
  "test.compiled-instruction.entry-export"
);
const compiledInstructionExportName = "run";
const compiledInstructionDispatchRef = functionRef(
  "test.compiled-instruction.dispatch"
);
const compiledInstructionDispatchStop = encodeVariant(
  exitLayout,
  instructionLimitExit()
);

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
  initialState?: WasmCpuArchitecturalStateInit;
  memoryPatches?: readonly CompiledInstructionMemoryPatch[];
  memoryRanges?: readonly CompiledInstructionMemoryRange[];
}>;

export type CompiledInstructionCompletion =
  | Exclude<RunStop, Readonly<{ kind: "instructionLimit" }>>
  | Readonly<{ kind: "completed"; targetEip: number }>
  | Readonly<{ kind: "dispatched"; targetEip: number }>;

export type CompiledInstructionResult = Readonly<{
  completion: CompiledInstructionCompletion;
  state: WasmCpuArchitecturalStateSnapshot;
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
  const built = buildInstructionProgram(instructions);
  const program = compileProgram(built.program);
  const dispatchTargets: number[] = [];
  const instance = instantiateCompiledProgram(
    program,
    {
      memories: new Map([
        [testExecutionModel.cpuState.resource, memories.cpuStateMemory],
        [
          testExecutionModel.memory.physical.ramResource,
          memories.guestMemory
        ]
      ]),
      functions: new Map([[
        built.dispatch.ref,
        (targetEip: number): bigint => {
          dispatchTargets.push(targetEip >>> 0);
          return compiledInstructionDispatchStop;
        }
      ]])
    }
  );
  const entry = instance.functionExports.get(compiledInstructionExport);

  ok(typeof entry === "function", "compiled instruction entry export is missing");
  const encodedExit: unknown = entry();

  ok(typeof encodedExit === "bigint", `compiled instruction returned ${typeof encodedExit}, expected bigint`);
  const rawState = readWasmCpuStateSnapshot(stateView);
  const architecturalFlags = readArchitecturalStatusFlags(memories.cpuStateMemory);
  const state = {
    ...wasmCpuArchitecturalStateOf(rawState),
    ...architecturalFlags
  };
  const stop = decodeExit(encodedExit);
  // The local dispatch target uses the budget stop only as its completion
  // sentinel. Core exits reach this point unchanged.
  ok(
    dispatchTargets.length <= 1,
    `compiled instruction dispatched ${dispatchTargets.length} times`
  );
  const dispatchedTarget = dispatchTargets[0];
  const completion: CompiledInstructionCompletion = stop.kind === "instructionLimit"
    ? dispatchedTarget === undefined
      ? { kind: "completed", targetEip: state.eip }
      : { kind: "dispatched", targetEip: dispatchedTarget }
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

function readArchitecturalStatusFlags(
  memory: WebAssembly.Memory
): Readonly<Record<X86StatusFlag, 0 | 1>> {
  const flags = createCpuStateHostView(
    createLayoutHostView(memory, cpuState.layout)
  ).flags;
  const result = {} as Record<X86StatusFlag, 0 | 1>;

  for (const flag of x86StatusFlags) {
    result[flag] = flags.readFlag(flag) ? 1 : 0;
  }

  return result;
}

function buildInstructionProgram(
  instructions: readonly IsaDecodedInstruction[]
) {
  const program = new ProgramBuilder(testExecutionModel.resources);
  const instructionLowerer = createInstructionLowerer({
    stateAccess: cpuStateAccess,
    memory: guestMemoryAccess,
    instructionCountField,
    buildExit
  });
  const entryType = functionType([], ["i64"]);
  const dispatchType = functionType(["i32"], ["i64"]);

  const dispatch = program.importFunction({
    ref: compiledInstructionDispatchRef,
    type: dispatchType,
    effects: noEffects,
    moduleName: programImportModuleName,
    name: "dispatch"
  });
  const fallthrough = program.defineFunction({
    ref: functionRef("test.compiled-instruction.fallthrough"),
    type: dispatchType,
    effects: noEffects
  }, (fn) => {
    fn.return([buildVariant(fn.values, exitLayout, instructionLimitExit())]);
  });
  const entry = program.defineFunction({
    ref: functionRef("test.compiled-instruction.entry"),
    type: entryType,
    effects: compiledInstructionEffects
  }, (fn) => {
    const finalFallthrough = instructionLowerer.lower(
      fn.region,
      instructionFunctionTerminals(dispatch),
      (builder) => {
        for (const instruction of instructions) {
          if (!builder.add(
            instruction.spec.semantics,
            instruction.operands.map(staticOperandBinding),
            staticInstructionLocation(instruction.address, instruction.nextEip)
          )) {
            break;
          }
        }
      }
    );

    if (finalFallthrough !== undefined) {
      fn.returnCall(fallthrough, [finalFallthrough]);
    }
  });

  program.exportFunction({
    ref: compiledInstructionExport,
    name: compiledInstructionExportName,
    target: entry.ref
  });
  return { program: program.finish(), dispatch };
}

function instructionFunctionTerminals(
  dispatch: CallTarget
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
const compiledInstructionEffects: StorageEffects = {
  reads: [wholeCpuState, ...testExecutionModel.memory.effects.reads],
  writes: [wholeCpuState, ...testExecutionModel.memory.effects.writes]
};

class FiniteInstructionReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: readonly number[], readonly baseAddress: number) {
    this.#bytes = Uint8Array.from(bytes);
  }

  readU8(address: number): IsaDecodeReadResult {
    const index = address - this.baseAddress;
    const value = this.#bytes[index];

    ok(
      Number.isInteger(index) && index >= 0 && value !== undefined,
      `compiled instruction fixture has no byte at 0x${address.toString(16)}`
    );

    return { kind: "value", value };
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
