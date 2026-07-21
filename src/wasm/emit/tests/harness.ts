import { assert } from "#common/assert.js";
import type { IrBlock } from "#ir/block.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { compileProgram } from "#compiler/program/compile.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import type { LegacyFunctionBodyContext } from "#compiler/program/legacy-body.js";
import {
  functionExportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { testExecutionModel } from "#test/support/execution-model.js";

const testModuleRunExportName = "run";

// Test-only module wrapper around the action emitter: imported state + guest
// memories, one run export returning the encoded i64 exit. The harness
// embeds like any host: dispatch escapes through an explicit block branch,
// bare action-body fallthrough reaches the sentinel tail lexically, and
// reports return their real encoded exits. External value n is the
// function's n-th i32 parameter. Module assembly for real use is the
// engines' job.

// Canonical Cpu exits leave unused high bits clear, while legacy JIT
// transfers require their high detail bits to be zero.
export const irBlockCompleted = -1n;
export const testModuleMemoryIndex = {
  cpuState: 0,
  guest: 1
} as const;

export type InstantiatedIrBlock = Readonly<{
  stateMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  run(...externals: number[]): bigint;
}>;

// The fragment with direct exits to the sentinel tail.
export function irBlockBody(
  block: IrBlock,
  externalParamCount = 0
): EncodedWasmFunctionBody {
  let encodedBody: EncodedWasmFunctionBody | undefined;
  const program = createIrBlockProgram(
    block,
    externalParamCount,
    (body) => (encodedBody = body)
  );

  compileProgram(program);
  assert(encodedBody !== undefined, "test IR block body was not encoded");
  return encodedBody;
}

function emitIrBlockBody(
  block: IrBlock,
  externalParamCount: number,
  context: LegacyFunctionBodyContext
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder(externalParamCount);
  const scratch = new WasmLocalScratchAllocator(body);
  const placement = context.placements.get(block);

  assert(placement !== undefined, "missing test IR block placement");

  body.block();
  emitActionFragment(block, {
    body,
    scratch,
    externalLocals: new Map(Array.from({ length: externalParamCount }, (_, id) => [id, id])),
    bindings: context.bindings,
    placement,
    embedding: {
      dispatch: { kind: "br", depth: 0 },
      fallthrough: { kind: "fallthrough" }
    }
  });
  body.endBlock();
  scratch.assertClear();
  return body.i64Const(irBlockCompleted).finish();
}

export async function instantiateIrBlock(
  block: IrBlock,
  externalParamCount = 0
): Promise<InstantiatedIrBlock> {
  const state = new WebAssembly.Memory({
    initial: testExecutionModel.cpuState.memoryImport.limits.minPages
  });
  const guest = new WebAssembly.Memory({
    initial: testExecutionModel.guestMemory.memoryImport.limits.minPages
  });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeIrBlockModule(block, externalParamCount)),
    {
      [programImportModuleName]: {
        [testExecutionModel.cpuState.memoryImport.name]: state,
        [testExecutionModel.guestMemory.memoryImport.name]: guest
      }
    }
  );
  const run = instance.exports[testModuleRunExportName];

  assert(
    typeof run === "function",
    `missing Wasm ${testModuleRunExportName} export`
  );

  return {
    stateMemory: state,
    stateView: new DataView(state.buffer),
    guestView: new DataView(guest.buffer),
    run: (...externals) => (run as (...args: number[]) => bigint)(...externals)
  };
}

// Same wrapper around an already finished body — typically a hand-written
// embedder function with fragments emitted inline.
export async function instantiateFunctionBody(
  body: EncodedWasmFunctionBody,
  paramCount = 0
): Promise<InstantiatedIrBlock> {
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeFunctionBodyModule(body, paramCount)),
    {
      [programImportModuleName]: {
        [testExecutionModel.cpuState.memoryImport.name]: state,
        [testExecutionModel.guestMemory.memoryImport.name]: guest
      }
    }
  );
  const run = instance.exports[testModuleRunExportName];

  assert(
    typeof run === "function",
    `missing Wasm ${testModuleRunExportName} export`
  );

  return {
    stateMemory: state,
    stateView: new DataView(state.buffer),
    guestView: new DataView(guest.buffer),
    run: (...externals) => (run as (...args: number[]) => bigint)(...externals)
  };
}

function encodeFunctionBodyModule(body: EncodedWasmFunctionBody, paramCount: number): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = initializeTestModule(module, paramCount);

  module.exportFunction(testModuleRunExportName, module.addFunction(typeIndex, body));
  return module.encode();
}

function encodeIrBlockModule(
  block: IrBlock,
  externalParamCount: number
): Uint8Array<ArrayBuffer> {
  return compileProgram(
    createIrBlockProgram(block, externalParamCount)
  ).bytes;
}

function createIrBlockProgram(
  block: IrBlock,
  externalParamCount: number,
  bodyEncoded?: (body: EncodedWasmFunctionBody) => void
): Program {
  const builder = new ProgramBuilder(testExecutionModel.resources);
  const entryType = functionType(
    Array.from({ length: externalParamCount }, () => "i32" as const),
    ["i64"]
  );
  const entrySignature = signatureRef("test.ir-block-entry-signature");
  const entry = functionRef("test.ir-block-entry");
  const cpuStateRef = testExecutionModel.cpuState.resource;
  const guestMemoryRef = testExecutionModel.guestMemory.resource;

  builder.signature({ ref: entrySignature, type: entryType });
  builder.legacyFunction({
    ref: entry,
    signature: entrySignature,
    calls: [],
    resources: [cpuStateRef, guestMemoryRef],
    globals: [],
    tables: [],
    irBlocks: [{ block, allowImplicitEntryFallthrough: true }],
    build: (context) => {
      assert(
        context.bindings.resourceIndex(cpuStateRef) === testModuleMemoryIndex.cpuState,
        "unexpected CPU-state memory import index"
      );
      const body = emitIrBlockBody(block, externalParamCount, context);

      bodyEncoded?.(body);
      return body;
    }
  });
  builder.exportFunction({
    ref: functionExportRef("test.ir-block-entry-export"),
    name: testModuleRunExportName,
    target: entry
  });
  return builder.finish();
}

function initializeTestModule(module: WasmModuleEncoder, paramCount: number): number {
  const cpuStateMemoryIndex = module.importMemory(
    programImportModuleName,
    testExecutionModel.cpuState.memoryImport.name,
    { minPages: 1 }
  );
  const guestMemoryIndex = module.importMemory(
    programImportModuleName,
    testExecutionModel.guestMemory.memoryImport.name,
    {
      minPages: guestMemoryMinimumPages
    }
  );

  assert(
    cpuStateMemoryIndex === testModuleMemoryIndex.cpuState &&
      guestMemoryIndex === testModuleMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const typeIndex = module.addFunctionType({
    params: Array.from({ length: paramCount }, () => wasmValueType.i32),
    results: [wasmValueType.i64]
  });

  return typeIndex;
}
