import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import { wasmValueType } from "#compiler/encoder/types.js";
import { ProgramBuilder, type Program } from "#compiler/program/builder.js";
import type { LegacyEffects, LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import {
  exportRef,
  functionRef,
  globalRef,
  resourceRef,
  signatureRef,
  type FunctionRef,
  type GlobalRef,
  type ResourceRef,
  type SignatureRef
} from "#compiler/program/refs.js";
import type { OpcodeDispatchNode } from "#core/decoder/opcode-dispatch.js";
import { wasmBlockExportName, wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { helperFunctionName, type HelperCallKey } from "#wasm/helpers/key.js";
import { allHelpers, encodeHelperBody, helperFunctionType } from "#wasm/helpers/module.js";
import {
  LegacyHelperIndexRegistryAdapter,
  type LegacyHelperIndexBinding
} from "#wasm/helpers/registry.js";
import {
  encodeRmDecodeHelperBody,
  RmDecodeHelpers,
  rmDecodeHelperType,
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

type HelperFunctionRef = Readonly<{
  key: HelperCallKey;
  ref: FunctionRef;
}>;

type CallRequirements = Readonly<{
  rmLengths: readonly number[];
  helpers: readonly HelperCallKey[];
}>;

type InterpreterProgramDeclarations = Readonly<{
  builder: ProgramBuilder;
  runSignature: SignatureRef;
  rmDecodeSignature: SignatureRef;
  helperSignature: SignatureRef;
  cpuState: ResourceRef;
  guestMemory: ResourceRef;
  rmGlobals: RmDecodeGlobalRefs;
}>;

export type BuiltInterpreterProgram = Readonly<{
  program: Program;
  handlers: readonly InterpreterHandler[];
  rmDecodeHelpers: readonly number[];
}>;

// Close every raw dependency before any factory is allowed to encode a body.
// Handler metadata remains an output of the existing raw root and is filled
// when encodeProgram realizes that root.
export function buildInterpreterProgram(): BuiltInterpreterProgram {
  const calls = callRequirements(interpreterDispatchRoot);
  const declarations = createInterpreterProgram();
  const handlers: InterpreterHandler[] = [];
  const helperFunctions = declareHelpers(declarations, calls.helpers);
  const rmFunctions = declareRmDecodeHelpers(declarations, calls.rmLengths);
  const run = functionRef("interpreter.run");
  const adapter = new DeclaredDependencyLegacyRootAdapter({
    cpuState: declarations.cpuState,
    guestMemory: declarations.guestMemory,
    rmGlobals: declarations.rmGlobals,
    rmFunctions,
    helperFunctions,
    handlers
  });

  declarations.builder.legacyFunction({
    ref: run,
    signature: declarations.runSignature,
    calls: [
      ...rmFunctions.map((binding) => binding.ref),
      ...helperFunctions.map((binding) => binding.ref)
    ],
    resources: [declarations.cpuState, declarations.guestMemory],
    globals: rmGlobalRefs(declarations.rmGlobals),
    tables: [],
    effects: legacyInterpreterEffects,
    traps: "may",
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
    rmDecodeHelpers: [...calls.rmLengths]
  };
}

function createInterpreterProgram(): InterpreterProgramDeclarations {
  const builder = new ProgramBuilder();
  const runSignature = signatureRef("interpreter.run-signature");
  const rmDecodeSignature = signatureRef("interpreter.rm-decode-signature");
  const helperSignature = signatureRef("interpreter.raw-helper-signature");
  const cpuState = resourceRef("interpreter.cpu-state");
  const guestMemory = resourceRef("interpreter.guest-memory");
  const rmGlobals = {
    base: globalRef("interpreter.rm-result.base"),
    offset: globalRef("interpreter.rm-result.offset"),
    cursor: globalRef("interpreter.rm-result.cursor")
  } satisfies RmDecodeGlobalRefs;

  builder.signature({
    ref: runSignature,
    type: { params: [wasmValueType.i32], results: [wasmValueType.i64] }
  });
  builder.signature({ ref: rmDecodeSignature, type: rmDecodeHelperType });
  builder.signature({ ref: helperSignature, type: helperFunctionType });
  builder.importMemory({
    ref: cpuState,
    moduleName: wasmImport.namespace,
    name: wasmImport.cpuStateMemoryName,
    limits: { minPages: 1 }
  });
  builder.importMemory({
    ref: guestMemory,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: wasmGuestMemoryMinPages }
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
    helperSignature,
    cpuState,
    guestMemory,
    rmGlobals
  };
}

function declareHelpers(
  program: InterpreterProgramDeclarations,
  helpers: readonly HelperCallKey[]
): readonly HelperFunctionRef[] {
  return helpers.map((key) => {
    const ref = functionRef(`interpreter.helper.${helperFunctionName(key)}`);

    program.builder.legacyFunction({
      ref,
      signature: program.helperSignature,
      calls: [],
      resources: [program.cpuState],
      globals: [],
      tables: [],
      effects: legacyInterpreterEffects,
      traps: "may",
      build: () => encodeHelperBody(key)
    });
    return { key, ref };
  });
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
      effects: legacyInterpreterEffects,
      traps: "may",
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
          guestMemoryIndex === wasmMemoryIndex.guest,
          `unexpected resolved interpreter guest-memory index: ${String(guestMemoryIndex)}`
        );
        assert(base !== undefined, "missing resolved interpreter R/M base global");
        assert(offset !== undefined, "missing resolved interpreter R/M offset global");
        assert(cursor !== undefined, "missing resolved interpreter R/M cursor global");
        return encodeRmDecodeHelperBody(opcodeLength, { base, offset, cursor });
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
  helperFunctions: readonly HelperFunctionRef[];
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
      rmFunctions: options.rmFunctions.map((binding) => ({ ...binding })),
      helperFunctions: options.helperFunctions.map((binding) => ({ ...binding }))
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
      guestMemoryIndex === wasmMemoryIndex.guest,
      `unexpected resolved interpreter guest-memory index: ${String(guestMemoryIndex)}`
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
    const helperBindings = this.#options.helperFunctions.map((binding): LegacyHelperIndexBinding => {
      const functionIndex = bindings.functions.get(binding.ref);

      assert(
        functionIndex !== undefined,
        `missing resolved interpreter helper ${helperFunctionName(binding.key)}`
      );
      return { key: binding.key, functionIndex };
    });
    const emittedHandlers: InterpreterHandler[] = [];
    const body = encodeRunLoopBody(
      new RmDecodeHelpers(rmFunctions, { base, offset, cursor }),
      new LegacyHelperIndexRegistryAdapter(helperBindings),
      emittedHandlers
    );

    this.#options.handlers.splice(0, this.#options.handlers.length, ...emittedHandlers);
    return body;
  }
}

function rmGlobalRefs(globals: RmDecodeGlobalRefs): readonly GlobalRef[] {
  return [globals.base, globals.offset, globals.cursor];
}

// Temporary bridge for the opaque run loop. Its declared calls may be a
// conservative superset: all flag helpers, plus one length-specialized R/M
// decoder for every ModRM opcode length in the dispatch tree.
function callRequirements(root: OpcodeDispatchNode): CallRequirements {
  const rmLengths = new Set<number>();

  collectRmLengths(root, rmLengths);
  return {
    rmLengths: [...rmLengths].sort((left, right) => left - right),
    helpers: allHelpers()
  };
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
