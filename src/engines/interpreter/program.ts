import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import type { LegacyEffects, LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import {
  exportRef,
  functionRef,
  globalRef,
  signatureRef,
  type FunctionRef,
  type GlobalRef,
  type SignatureRef
} from "#compiler/program/refs.js";
import {
  type ResourceRef
} from "#compiler/ir/resource.js";
import {
  cpuState,
  cpuStatusFlagResolvers
} from "#cpu/state.js";
import type { OpcodeDispatchNode } from "#core/decoder/opcode-dispatch.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { statusFlagResolverType } from "#core/flags/lazy/resolvers.js";
import { wasmBlockExportName, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";
import { guestMemoryResource } from "#memory/resource.js";
import {
  encodeRmDecodeHelperBody,
  RmDecodeHelpers,
  rmDecodeFunctionType,
  type ResolvedRmDecodeFunction
} from "./decode.js";
import type { InterpreterHandler } from "./handlers.js";
import { interpreterDispatchRoot } from "./instructions.js";
import { encodeRunLoopBody } from "./run-loop.js";

type RmDecodeGlobalRefs = Readonly<{
  base: GlobalRef;
  offset: GlobalRef;
  cursor: GlobalRef;
}>;

type RmDecodeFunctionRef = Readonly<{
  opcodeLength: number;
  ref: FunctionRef;
}>;

type InterpreterProgramDeclarations = Readonly<{
  builder: ProgramBuilder;
  runSignature: SignatureRef;
  rmDecodeSignature: SignatureRef;
  cpuState: ResourceRef;
  guestMemory: ResourceRef;
  rmGlobals: RmDecodeGlobalRefs;
}>;

const interpreterRunFunctionType = functionType(["i32"], ["i64"]);

export type BuiltInterpreterProgram = Readonly<{
  program: Program;
  handlers: readonly InterpreterHandler[];
  rmDecodeHelpers: readonly number[];
}>;

// Close every raw dependency before any factory is allowed to encode a body.
// Handler metadata remains an output of the existing raw root and is filled
// when encodeProgram realizes that root.
export function buildInterpreterProgram(): BuiltInterpreterProgram {
  const rmDecodeLengths = requiredRmDecodeLengths(interpreterDispatchRoot);
  const declarations = createInterpreterProgram();
  const handlers: InterpreterHandler[] = [];
  const rmFunctions = declareRmDecodeHelpers(declarations, rmDecodeLengths);
  const resolverFunctions = cpuStatusFlagResolvers.members(x86StatusFlags);
  const run = functionRef("interpreter.run");
  const adapter = new DeclaredDependencyLegacyRootAdapter({
    cpuState: declarations.cpuState,
    guestMemory: declarations.guestMemory,
    rmGlobals: declarations.rmGlobals,
    rmFunctions,
    handlers
  });

  declarations.builder.legacyFunction({
    ref: run,
    signature: declarations.runSignature,
    calls: [
      ...rmFunctions.map((binding) => binding.ref),
      ...resolverFunctions
    ],
    resources: [declarations.cpuState, declarations.guestMemory],
    globals: rmGlobalRefs(declarations.rmGlobals),
    tables: [],
    irBlocks: [],
    effects: legacyInterpreterEffects,
    build: (bindings) => adapter.build(bindings)
  });
  declarations.builder.exportFunction({
    ref: exportRef("interpreter.run-export"),
    name: wasmBlockExportName,
    target: run
  });

  return {
    program: declarations.builder.finish(),
    handlers,
    rmDecodeHelpers: [...rmDecodeLengths]
  };
}

function createInterpreterProgram(): InterpreterProgramDeclarations {
  const builder = new ProgramBuilder();
  const runSignature = signatureRef("interpreter.run-signature");
  const rmDecodeSignature = signatureRef("interpreter.rm-decode-signature");
  const cpuStateRef = cpuState.resource;
  const guestMemory = guestMemoryResource;
  const rmGlobals = {
    base: globalRef("interpreter.rm-result.base"),
    offset: globalRef("interpreter.rm-result.offset"),
    cursor: globalRef("interpreter.rm-result.cursor")
  } satisfies RmDecodeGlobalRefs;

  builder.signature({
    ref: runSignature,
    type: interpreterRunFunctionType
  });
  builder.signature({ ref: rmDecodeSignature, type: rmDecodeFunctionType });
  builder.signature({
    ref: signatureRef("interpreter.status-flag-resolver-signature"),
    type: statusFlagResolverType
  });
  builder.importMemory({
    ref: cpuStateRef,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  builder.importMemory({
    ref: guestMemory,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });
  builder.global({
    ref: rmGlobals.base,
    type: wasmValueType.i32,
    mutable: true,
    initialValue: 0
  });
  builder.global({
    ref: rmGlobals.offset,
    type: wasmValueType.i32,
    mutable: true,
    initialValue: 0
  });
  builder.global({
    ref: rmGlobals.cursor,
    type: wasmValueType.i32,
    mutable: true,
    initialValue: 0
  });

  return {
    builder,
    runSignature,
    rmDecodeSignature,
    cpuState: cpuStateRef,
    guestMemory,
    rmGlobals
  };
}

function declareRmDecodeHelpers(
  program: InterpreterProgramDeclarations,
  opcodeLengths: readonly number[]
): readonly RmDecodeFunctionRef[] {
  return opcodeLengths.map((opcodeLength) => {
    const ref = functionRef(`interpreter.rm-decode.${opcodeLength}`);

    program.builder.legacyFunction({
      ref,
      signature: program.rmDecodeSignature,
      calls: [],
      resources: [program.cpuState, program.guestMemory],
      globals: rmGlobalRefs(program.rmGlobals),
      tables: [],
      irBlocks: [],
      effects: legacyInterpreterEffects,
      build: (bindings) => {
        const cpuStateMemoryIndex = bindings.resources.get(program.cpuState);
        const guestMemoryIndex = bindings.resources.get(program.guestMemory);
        const base = bindings.globals.get(program.rmGlobals.base);
        const offset = bindings.globals.get(program.rmGlobals.offset);
        const cursor = bindings.globals.get(program.rmGlobals.cursor);

        assert(
          cpuStateMemoryIndex === wasmMemoryIndex.cpuState,
          `unexpected resolved interpreter CPU-state memory index: ${String(cpuStateMemoryIndex)}`
        );
        assert(
          guestMemoryIndex !== undefined,
          "missing resolved interpreter guest-memory resource"
        );
        assert(base !== undefined, "missing resolved interpreter R/M base global");
        assert(offset !== undefined, "missing resolved interpreter R/M offset global");
        assert(cursor !== undefined, "missing resolved interpreter R/M cursor global");
        return encodeRmDecodeHelperBody(
          opcodeLength,
          { base, offset, cursor },
          bindings.resources
        );
      }
    });
    return { opcodeLength, ref };
  });
}

type DeclaredDependencyLegacyRootOptions = Readonly<{
  cpuState: ResourceRef;
  guestMemory: ResourceRef;
  rmGlobals: RmDecodeGlobalRefs;
  rmFunctions: readonly RmDecodeFunctionRef[];
  handlers: InterpreterHandler[];
}>;

// The run loop stays opaque for now, but this adapter can resolve only the
// dependency identities declared before ProgramBuilder closes.
class DeclaredDependencyLegacyRootAdapter {
  readonly #options: DeclaredDependencyLegacyRootOptions;

  constructor(options: DeclaredDependencyLegacyRootOptions) {
    this.#options = {
      ...options,
      rmGlobals: { ...options.rmGlobals },
      rmFunctions: options.rmFunctions.map((binding) => ({ ...binding }))
    };
  }

  build(bindings: LegacyFunctionBindings): EncodedWasmFunctionBody {
    const cpuStateMemoryIndex = bindings.resources.get(this.#options.cpuState);
    const guestMemoryIndex = bindings.resources.get(this.#options.guestMemory);
    const base = bindings.globals.get(this.#options.rmGlobals.base);
    const offset = bindings.globals.get(this.#options.rmGlobals.offset);
    const cursor = bindings.globals.get(this.#options.rmGlobals.cursor);

    assert(
      cpuStateMemoryIndex === wasmMemoryIndex.cpuState,
      `unexpected resolved interpreter CPU-state memory index: ${String(cpuStateMemoryIndex)}`
    );
    assert(
      guestMemoryIndex !== undefined,
      "missing resolved interpreter guest-memory resource"
    );
    assert(base !== undefined, "missing resolved interpreter R/M base global");
    assert(offset !== undefined, "missing resolved interpreter R/M offset global");
    assert(cursor !== undefined, "missing resolved interpreter R/M cursor global");

    const rmFunctions = this.#options.rmFunctions.map((binding): ResolvedRmDecodeFunction => {
      const functionIndex = bindings.functions.get(binding.ref);

      assert(
        functionIndex !== undefined,
        `missing resolved interpreter R/M helper for opcode length ${binding.opcodeLength}`
      );
      return { opcodeLength: binding.opcodeLength, functionIndex };
    });
    const emittedHandlers: InterpreterHandler[] = [];
    const body = encodeRunLoopBody(
      new RmDecodeHelpers(rmFunctions, { base, offset, cursor }),
      {
        functionIndices: bindings.definitionIndices,
        typeIndices: bindings.typeIndices,
        tableIndices: bindings.tables,
        resourceIndices: bindings.resources
      },
      emittedHandlers
    );

    this.#options.handlers.splice(0, this.#options.handlers.length, ...emittedHandlers);
    return body;
  }
}

function rmGlobalRefs(globals: RmDecodeGlobalRefs): readonly GlobalRef[] {
  return [globals.base, globals.offset, globals.cursor];
}

// The opaque run loop must conservatively declare every length-specialized
// R/M decoder it may call. Its complete status-flag function inventory is
// supplied separately by Core flags.
function requiredRmDecodeLengths(root: OpcodeDispatchNode): readonly number[] {
  const rmLengths = new Set<number>();

  collectRmLengths(root, rmLengths);
  return [...rmLengths].sort((left, right) => left - right);
}

function collectRmLengths(node: OpcodeDispatchNode, lengths: Set<number>): void {
  if (node.leaf?.prefixFlags.some((candidates) => candidates.kind === "modRm") === true) {
    lengths.add(node.leaf.opcodeLength);
  }

  for (const child of node.next) {
    if (child !== undefined) {
      collectRmLengths(child, lengths);
    }
  }
}

const legacyInterpreterEffects: LegacyEffects = "world";
