import { decodeIsaInstructionFromReader } from "#x86/isa/decoder/decode.js";
import { ByteArrayDecodeReader } from "#x86/isa/decoder/tests/helpers.js";
import type { IsaDecodedInstruction } from "#x86/isa/decoder/types.js";
import type { CpuState } from "#x86/state/cpu-state.js";
import { wasmImport } from "#backends/wasm/abi.js";
import { decodeExit, type DecodedExit } from "#backends/wasm/exit.js";
import { readWasmCpuState, writeWasmCpuState } from "#backends/wasm/state-layout.js";
import {
  buildBlock,
  buildBlockExpressions,
  encodeJitBlock,
  jitBlockExportName,
  planJitCodegen,
  validateBlock
} from "#backends/wasm/jit/block.js";

export type JitBlockRunResult = Readonly<{
  state: CpuState;
  exit: DecodedExit;
  guestView: DataView;
}>;

export async function runJitBlock(
  bytes: readonly number[],
  initialState: CpuState,
  memory: readonly Readonly<{ address: number; bytes: readonly number[] }>[] = []
): Promise<JitBlockRunResult> {
  const instructions = decodeInstructions(bytes, initialState.eip);
  const block = buildBlock(instructions);
  validateBlock(block);
  const module = new WebAssembly.Module(encodeJitBlock([
    planJitCodegen(buildBlockExpressions(block))
  ]));
  const stateMemory = new WebAssembly.Memory({ initial: 1 });
  const guestMemory = new WebAssembly.Memory({ initial: 1 });
  const stateView = new DataView(stateMemory.buffer);
  const guestView = new DataView(guestMemory.buffer);

  writeState(stateView, initialState);
  writeGuestMemory(guestView, memory);

  const instance = await WebAssembly.instantiate(module, {
    [wasmImport.moduleName]: {
      [wasmImport.stateMemoryName]: stateMemory,
      [wasmImport.guestMemoryName]: guestMemory
    }
  });
  const exportName = jitBlockExportName(initialState.eip);
  const run = instance.exports[exportName];

  if (typeof run !== "function") {
    throw new Error(`expected exported function '${exportName}'`);
  }

  const encodedExit: unknown = run();

  if (typeof encodedExit !== "bigint") {
    throw new Error(`expected bigint exit result, got ${typeof encodedExit}`);
  }

  return {
    state: readState(stateView),
    exit: decodeExit(encodedExit),
    guestView
  };
}

function decodeInstructions(bytes: readonly number[], address: number): readonly IsaDecodedInstruction[] {
  const raw = Uint8Array.from(bytes);
  const reader = new ByteArrayDecodeReader(raw, address);
  const instructions: IsaDecodedInstruction[] = [];
  let eip = address;

  while (eip - address < raw.length) {
    const result = decodeIsaInstructionFromReader(reader, eip);

    if (result.kind !== "ok") {
      throw new Error(`expected decode success, got unsupported byte ${result.unsupportedByte}`);
    }

    instructions.push(result.instruction);
    eip = result.instruction.nextEip;
  }

  return instructions;
}

function writeState(view: DataView, state: CpuState): void {
  writeWasmCpuState(view, state);
}

function writeGuestMemory(
  view: DataView,
  memory: readonly Readonly<{ address: number; bytes: readonly number[] }>[]
): void {
  for (const entry of memory) {
    for (let index = 0; index < entry.bytes.length; index += 1) {
      view.setUint8(entry.address + index, entry.bytes[index] ?? 0);
    }
  }
}

function readState(view: DataView): CpuState {
  return readWasmCpuState(view);
}
