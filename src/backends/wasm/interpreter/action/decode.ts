import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#wasm/encoder/types.js";
import { emitRmAddressFragment, emitSibFetch, type RmAddressParts } from "./fragments.js";
import type { ActionInterpreterLocals } from "./locals.js";

// The memory form of a ModRM rm operand, shared as one module-level helper
// function per opcode length so every fragment offset stays static. The
// mod/rm/SIB case split is genuine control structure and stays hand-written;
// each case's loads are action fragments. The decoded effective address and
// the bytes consumed so far (opcode + ModRM + SIB + displacement) leave
// through the module globals.

// (eip, mod, rm) -> the encoded exit, 0 on success. The i64-only result
// keeps the fragments' fault returns valid unchanged inside the helper, and
// 0 never collides with a fault: an encoded decode fault has a nonzero
// reason field.
const rmDecodeHelperType = {
  params: [wasmValueType.i32, wasmValueType.i32, wasmValueType.i32],
  results: [wasmValueType.i64]
} as const satisfies WasmFunctionType;

type RmDecodeGlobals = Readonly<{ address: number; length: number }>;

export type RmDecodeCallContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: ActionInterpreterLocals;
}>;

// One module's shared rm-decode helpers: the result globals plus one helper
// function per opcode length, added on first use.
export class RmDecodeHelpers {
  readonly #module: WasmModuleEncoder;
  readonly #typeIndex: number;
  readonly #globals: RmDecodeGlobals;
  readonly #functionIndexes = new Map<number, number>();

  constructor(module: WasmModuleEncoder) {
    this.#module = module;
    this.#typeIndex = module.addFunctionType(rmDecodeHelperType);
    this.#globals = {
      address: module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 0 }),
      length: module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 0 })
    };
  }

  // A fault result returns as-is, so payload, detail, and the unadvanced eip
  // match the inline emission exactly.
  emitMemoryAddressDecode(context: RmDecodeCallContext, opcodeLength: number): void {
    const { body, locals } = context;
    const helperIndex = this.#functionIndex(opcodeLength);

    body.localGet(locals.eip).localGet(locals.mod).localGet(locals.rm).callFunction(helperIndex);
    context.scratch.withLocals([wasmValueType.i64], ([status]) => {
      body.localTee(status).i64Eqz().ifBlock();
      body.globalGet(this.#globals.address).localSet(locals.address);
      body.globalGet(this.#globals.length).localSet(locals.length);
      body.elseBlock();
      body.localGet(status).returnFromFunction();
      body.endBlock();
    });
  }

  emittedOpcodeLengths(): readonly number[] {
    return [...this.#functionIndexes.keys()];
  }

  #functionIndex(opcodeLength: number): number {
    const existing = this.#functionIndexes.get(opcodeLength);

    if (existing !== undefined) {
      return existing;
    }

    const functionIndex = this.#module.addFunction(
      this.#typeIndex,
      encodeRmDecodeHelperBody(opcodeLength, this.#globals)
    );

    this.#functionIndexes.set(opcodeLength, functionIndex);
    return functionIndex;
  }
}

type HelperLocals = Readonly<{
  eip: number;
  mod: number;
  rm: number;
  scaledIndex: number;
  sibBase: number;
  address: number;
}>;

type HelperContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: HelperLocals;
  globals: RmDecodeGlobals;
}>;

function encodeRmDecodeHelperBody(
  opcodeLength: number,
  globals: RmDecodeGlobals
): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder(rmDecodeHelperType.params.length);
  const scratch = new WasmLocalScratchAllocator(body);
  const context: HelperContext = {
    body,
    scratch,
    locals: {
      eip: 0,
      mod: 1,
      rm: 2,
      scaledIndex: body.addLocal(wasmValueType.i32),
      sibBase: body.addLocal(wasmValueType.i32),
      address: body.addLocal(wasmValueType.i32)
    },
    globals
  };
  const modRmEnd = opcodeLength + 1;

  body.localGet(context.locals.rm).i32Const(0b100).i32Eq().ifBlock();
  emitSibAddressCases(context, modRmEnd);
  body.elseBlock();
  emitPlainAddressCases(context, modRmEnd);
  body.endBlock();
  scratch.assertClear();
  return body.i64Const(0n).end();
}

function emitPlainAddressCases(context: HelperContext, modRmEnd: number): void {
  const { body, locals } = context;

  emitModCases(context, {
    mod0: () => {
      body.localGet(locals.rm).i32Const(0b101).i32Eq().ifBlock();
      emitAddressCase(context, { displacement: { offset: modRmEnd, width: 32 } }, modRmEnd + 4);
      body.elseBlock();
      emitAddressCase(context, { baseRegLocal: locals.rm }, modRmEnd);
      body.endBlock();
    },
    mod1: () =>
      emitAddressCase(
        context,
        { baseRegLocal: locals.rm, displacement: { offset: modRmEnd, width: 8 } },
        modRmEnd + 1
      ),
    mod2: () =>
      emitAddressCase(
        context,
        { baseRegLocal: locals.rm, displacement: { offset: modRmEnd, width: 32 } },
        modRmEnd + 4
      )
  });
}

function emitSibAddressCases(context: HelperContext, modRmEnd: number): void {
  const { body, locals } = context;
  const sibEnd = modRmEnd + 1;

  emitSibFetch(context, locals.eip, modRmEnd, {
    scaledIndexLocal: locals.scaledIndex,
    baseLocal: locals.sibBase
  });
  emitModCases(context, {
    mod0: () => {
      body.localGet(locals.sibBase).i32Const(0b101).i32Eq().ifBlock();
      emitAddressCase(
        context,
        { scaledIndexLocal: locals.scaledIndex, displacement: { offset: sibEnd, width: 32 } },
        sibEnd + 4
      );
      body.elseBlock();
      emitAddressCase(
        context,
        { scaledIndexLocal: locals.scaledIndex, baseRegLocal: locals.sibBase },
        sibEnd
      );
      body.endBlock();
    },
    mod1: () =>
      emitAddressCase(
        context,
        {
          scaledIndexLocal: locals.scaledIndex,
          baseRegLocal: locals.sibBase,
          displacement: { offset: sibEnd, width: 8 }
        },
        sibEnd + 1
      ),
    mod2: () =>
      emitAddressCase(
        context,
        {
          scaledIndexLocal: locals.scaledIndex,
          baseRegLocal: locals.sibBase,
          displacement: { offset: sibEnd, width: 32 }
        },
        sibEnd + 4
      )
  });
}

// mod 3 is the caller's register form; the memory cases split 0/1/2 here.
function emitModCases(
  context: HelperContext,
  cases: Readonly<{ mod0: () => void; mod1: () => void; mod2: () => void }>
): void {
  const { body, locals } = context;

  body.localGet(locals.mod).i32Eqz().ifBlock();
  cases.mod0();
  body.elseBlock();
  body.localGet(locals.mod).i32Const(1).i32Eq().ifBlock();
  cases.mod1();
  body.elseBlock();
  cases.mod2();
  body.endBlock();
  body.endBlock();
}

function emitAddressCase(context: HelperContext, parts: RmAddressParts, length: number): void {
  const { body, locals, globals } = context;

  emitRmAddressFragment(context, locals.eip, parts, locals.address);
  body.localGet(locals.address).globalSet(globals.address);
  body.i32Const(length).globalSet(globals.length);
}
