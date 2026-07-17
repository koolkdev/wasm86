import { assert } from "#common/assert.js";
import type { IrBlock } from "#ir/block.js";
import { wasmBlockExportName, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import {
  WasmFunctionBodyEncoder,
  type EncodedWasmFunctionBody
} from "#compiler/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import type { LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import {
  exportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import { resourceRef } from "#compiler/ir/resource.js";
import { statusFlagResolverType } from "#core/flags/resolvers.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { guestMemoryResource } from "#memory/flat.js";

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

export type InstantiatedIrBlock = Readonly<{
  stateMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  run(...externals: number[]): bigint;
}>;

// The fragment with direct exits to the sentinel tail.
export function irBlockBody(block: IrBlock, externalParamCount = 0): EncodedWasmFunctionBody {
  let encodedBody: EncodedWasmFunctionBody | undefined;
  const program = createIrBlockProgram(
    block,
    externalParamCount,
    (body) => (encodedBody = body)
  );

  encodeProgram(program);
  assert(encodedBody !== undefined, "test IR block body was not encoded");
  return encodedBody;
}

function emitIrBlockBody(
  block: IrBlock,
  externalParamCount: number,
  bindings: LegacyFunctionBindings
): EncodedWasmFunctionBody {
  const body = new WasmFunctionBodyEncoder(externalParamCount);
  const scratch = new WasmLocalScratchAllocator(body);
  const placement = bindings.placements.get(block);

  assert(placement !== undefined, "missing test IR block placement");

  body.block();
  emitActionFragment(block, {
    body,
    scratch,
    externalLocals: new Map(Array.from({ length: externalParamCount }, (_, id) => [id, id])),
    functionIndices: bindings.definitionIndices,
    resourceIndices: bindings.resources,
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
  const state = new WebAssembly.Memory({ initial: 1 });
  const guest = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeIrBlockModule(block, externalParamCount)),
    {
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: state,
        [wasmImport.guestMemoryName]: guest
      }
    }
  );
  const run = instance.exports[wasmBlockExportName];

  assert(typeof run === "function", `missing Wasm ${wasmBlockExportName} export`);

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
      [wasmImport.namespace]: {
        [wasmImport.cpuStateMemoryName]: state,
        [wasmImport.guestMemoryName]: guest
      }
    }
  );
  const run = instance.exports[wasmBlockExportName];

  assert(typeof run === "function", `missing Wasm ${wasmBlockExportName} export`);

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

  module.exportFunction(wasmBlockExportName, module.addFunction(typeIndex, body));
  return module.encode();
}

function encodeIrBlockModule(block: IrBlock, externalParamCount: number): Uint8Array<ArrayBuffer> {
  return encodeProgram(createIrBlockProgram(block, externalParamCount));
}

function createIrBlockProgram(
  block: IrBlock,
  externalParamCount: number,
  bodyEncoded?: (body: EncodedWasmFunctionBody) => void
): Program {
  const builder = new ProgramBuilder();
  const entryType = functionType(
    Array.from({ length: externalParamCount }, () => "i32" as const),
    ["i64"]
  );
  const entrySignature = signatureRef("test.ir-block-entry-signature");
  const entry = functionRef("test.ir-block-entry");
  const cpuState = resourceRef("test.ir-block-cpu-state");

  builder.signature({ ref: entrySignature, type: entryType });
  builder.signature({
    ref: signatureRef("test.status-flag-resolver-signature"),
    type: statusFlagResolverType
  });
  builder.importMemory({
    ref: cpuState,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  builder.importMemory({
    ref: guestMemoryResource,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });
  builder.legacyFunction({
    ref: entry,
    signature: entrySignature,
    calls: [],
    resources: [cpuState, guestMemoryResource],
    globals: [],
    tables: [],
    irBlocks: [{ block, allowImplicitEntryFallthrough: true }],
    build: (bindings) => {
      assert(
        bindings.resources.get(cpuState) === wasmMemoryIndex.cpuState,
        "unexpected CPU-state memory import index"
      );
      assert(
        bindings.resources.has(guestMemoryResource),
        "missing resolved guest-memory resource"
      );
      const body = emitIrBlockBody(block, externalParamCount, bindings);

      bodyEncoded?.(body);
      return body;
    }
  });
  builder.exportFunction({
    ref: exportRef("test.ir-block-entry-export"),
    name: wasmBlockExportName,
    target: entry
  });
  return validateProgramPlacements(builder.finish());
}

function validateProgramPlacements(program: Program): Program {
  for (const placement of program.placements.values()) {
    validatePlacement(placement.block, placement.analysis, placement.plan);
  }
  return program;
}

function initializeTestModule(module: WasmModuleEncoder, paramCount: number): number {
  const cpuStateMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, {
    minPages: guestMemoryMinimumPages
  });

  assert(
    cpuStateMemoryIndex === wasmMemoryIndex.cpuState && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const typeIndex = module.addFunctionType({
    params: Array.from({ length: paramCount }, () => wasmValueType.i32),
    results: [wasmValueType.i64]
  });

  return typeIndex;
}
