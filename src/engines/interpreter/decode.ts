import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import type { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType, type WasmFunctionType } from "#wasm/encoder/types.js";
import {
  emitRmAddressFragment,
  emitSibFetch,
  type DecodeCursor,
  type RmAddressParts
} from "./fragments.js";
import type {
  InterpreterLocals,
  ModRmScratch,
  RmAddressScratch
} from "./locals.js";

// The memory form of a ModRM rm operand, shared as one module-level helper
// function per opcode length so every fragment offset stays static. The
// mod/rm/SIB case split is genuine control structure and stays hand-written;
// each case's loads are action fragments. The decoded base register field,
// the summed state-independent address terms, and the cursor after the
// address bytes (opcode + ModRM + SIB + displacement) leave through the
// module globals.

// Reported in the base global by ModRM's two base-less cases (mod 0 rm 101,
// SIB mod 0 base 101), which put the whole sum in offset.
export const noBaseRegister = 8;

// (eip, mod, rm) -> the encoded exit, 0 on success. The i64-only result
// keeps the fragments' fault returns valid unchanged inside the helper, and
// 0 never collides with a fault: an encoded decode fault has a nonzero
// reason field.
const rmDecodeHelperType = {
  params: [wasmValueType.i32, wasmValueType.i32, wasmValueType.i32],
  results: [wasmValueType.i64]
} as const satisfies WasmFunctionType;

type RmDecodeGlobals = Readonly<{ base: number; offset: number; cursor: number }>;

export type RmDecodeCallContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: InterpreterLocals;
  modRm: ModRmScratch;
  rmAddress: RmAddressScratch;
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
      base: module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 0 }),
      offset: module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 0 }),
      cursor: module.addGlobal({ type: wasmValueType.i32, mutable: true, initialValue: 0 })
    };
  }

  // A fault result returns as-is, so exception fields and the unadvanced eip
  // match the inline emission exactly.
  emitMemoryAddressDecode(context: RmDecodeCallContext, opcodeLength: number): void {
    const { body, locals, modRm, rmAddress } = context;
    const helperIndex = this.#functionIndex(opcodeLength);

    body.localGet(locals.eip).localGet(modRm.mod).localGet(modRm.rm).callFunction(helperIndex);
    context.scratch.withLocals([wasmValueType.i64], ([status]) => {
      body.localTee(status).i64Eqz().ifBlock();
      body.globalGet(this.#globals.base).localSet(rmAddress.base);
      body.globalGet(this.#globals.offset).localSet(rmAddress.offset);
      body.globalGet(this.#globals.cursor).localSet(rmAddress.addressCursor);
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
  offset: number;
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
      offset: body.addLocal(wasmValueType.i32)
    },
    globals
  };
  const cursorAfterModRm: DecodeCursor = { kind: "static", offset: opcodeLength + 1 };

  body.localGet(context.locals.rm).i32Const(0b100).i32Eq().ifBlock();
  emitSibAddressCases(context, cursorAfterModRm);
  body.elseBlock();
  emitPlainAddressCases(context, cursorAfterModRm);
  body.endBlock();
  scratch.assertClear();
  return body.i64Const(0n).end();
}

function emitPlainAddressCases(context: HelperContext, cursor: DecodeCursor): void {
  const { body, locals } = context;

  emitModCases(context, {
    mod0: () => {
      body.localGet(locals.rm).i32Const(0b101).i32Eq().ifBlock();
      emitAddressCase(context, undefined, { displacement: { width: 32 } }, cursor);
      body.elseBlock();
      emitAddressCase(context, locals.rm, {}, cursor);
      body.endBlock();
    },
    mod1: () => emitAddressCase(context, locals.rm, { displacement: { width: 8 } }, cursor),
    mod2: () => emitAddressCase(context, locals.rm, { displacement: { width: 32 } }, cursor)
  });
}

function emitSibAddressCases(context: HelperContext, cursor: DecodeCursor): void {
  const { body, locals } = context;

  const cursorAfterSib = emitSibFetch(context, locals.eip, cursor, {
    scaledIndexLocal: locals.scaledIndex,
    baseLocal: locals.sibBase
  });

  emitModCases(context, {
    mod0: () => {
      body.localGet(locals.sibBase).i32Const(0b101).i32Eq().ifBlock();
      emitAddressCase(
        context,
        undefined,
        { scaledIndexLocal: locals.scaledIndex, displacement: { width: 32 } },
        cursorAfterSib
      );
      body.elseBlock();
      emitAddressCase(context, locals.sibBase, { scaledIndexLocal: locals.scaledIndex }, cursorAfterSib);
      body.endBlock();
    },
    mod1: () =>
      emitAddressCase(
        context,
        locals.sibBase,
        { scaledIndexLocal: locals.scaledIndex, displacement: { width: 8 } },
        cursorAfterSib
      ),
    mod2: () =>
      emitAddressCase(
        context,
        locals.sibBase,
        { scaledIndexLocal: locals.scaledIndex, displacement: { width: 32 } },
        cursorAfterSib
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

function emitAddressCase(
  context: HelperContext,
  baseLocal: number | undefined,
  parts: RmAddressParts,
  cursor: DecodeCursor
): void {
  const { body, locals, globals } = context;

  if (baseLocal === undefined) {
    body.i32Const(noBaseRegister).globalSet(globals.base);
  } else {
    body.localGet(baseLocal).globalSet(globals.base);
  }

  const cursorAfterAddress = emitRmAddressFragment(context, locals.eip, parts, cursor, locals.offset);

  body.localGet(locals.offset).globalSet(globals.offset);

  switch (cursorAfterAddress.kind) {
    case "static":
      body.i32Const(cursorAfterAddress.offset);
      break;
    case "local":
      body.localGet(cursorAfterAddress.local);
      break;
  }

  body.globalSet(globals.cursor);
}
