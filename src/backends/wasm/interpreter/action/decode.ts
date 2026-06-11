import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { emitRmAddressFragment, emitSibFetch, type RmAddressParts } from "./fragments.js";
import type { ActionInterpreterLocals } from "./locals.js";

// The memory form of a ModRM rm operand. The mod/rm/SIB case split is
// genuine control structure and stays hand-written; each case's loads are
// action fragments. Afterwards locals.address holds the effective address
// and locals.length the bytes consumed so far (opcode + ModRM + SIB +
// displacement).

export type RmDecodeContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: ActionInterpreterLocals;
}>;

export function emitRmMemoryAddressDecode(context: RmDecodeContext, opcodeLength: number): void {
  const { body, locals } = context;
  const modRmEnd = opcodeLength + 1;

  body.localGet(locals.rm).i32Const(0b100).i32Eq().ifBlock();
  emitSibAddressCases(context, modRmEnd);
  body.elseBlock();
  emitPlainAddressCases(context, modRmEnd);
  body.endBlock();
}

function emitPlainAddressCases(context: RmDecodeContext, modRmEnd: number): void {
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

function emitSibAddressCases(context: RmDecodeContext, modRmEnd: number): void {
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
  context: RmDecodeContext,
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

function emitAddressCase(context: RmDecodeContext, parts: RmAddressParts, length: number): void {
  emitRmAddressFragment(context, context.locals.eip, parts, context.locals.address);
  context.body.i32Const(length).localSet(context.locals.length);
}
