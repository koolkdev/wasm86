import { assert } from "#common/assert.js";
import { createActionBuilder } from "#ir/action/builder.js";
import {
  immExternalBinding,
  memExternalBinding,
  regBinding,
  regDynamicBinding,
  type ExternalValueId,
  type OperandBinding
} from "#ir/action/operands.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import type { ExpandedInstructionSpec, OperandSpec, RegOperandType } from "#x86/schema/types.js";
import { reg16, reg32, reg8, type RegName } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { emitActionFragment } from "#wasm/emit/action/emit.js";
import {
  emitImmediateFetch,
  emitRelTargetFetch,
  type DecodeCursor
} from "./fragments.js";
import type { InterpreterLocals } from "./locals.js";

// Instruction handlers are single-instruction ActionBlocks over the existing
// semantics templates. Decoded operands arrive as externals — dynamic
// register indices, immediates, computed addresses — and eip/nextEip are
// externals too, so one handler body serves every register pair and address.

// The rm operand's resolved addressing form; "plain" has no rm operand.
export type HandlerForm = "plain" | "register" | "memory";

export type InterpreterHandler = Readonly<{
  instructionId: string;
  opcode: readonly number[];
  form: HandlerForm;
}>;

export type HandlerEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: InterpreterLocals;
  // Label depth from the emission point to the instruction-complete target.
  continueDepth: number;
  handlers: InterpreterHandler[];
}>;

export function emitInstructionHandler(
  context: HandlerEmitContext,
  instruction: ExpandedInstructionSpec<SemanticTemplate>,
  form: HandlerForm,
  cursorAfterDispatch: DecodeCursor
): void {
  const operands = instruction.spec.operands ?? [];

  assert(
    operands.filter((operand) => operand.kind === "imm" || operand.kind === "rel").length <= 1,
    `${instruction.spec.id}: only one trailing value operand is supported`
  );

  const externals = new HandlerExternals();
  const bindings: OperandBinding[] = [];
  let cursor = cursorAfterDispatch;

  for (const operand of operands) {
    const decoded = decodeOperand(context, instruction, operand, form, cursor, externals);

    bindings.push(decoded.binding);
    cursor = decoded.cursor;
  }

  emitNextEip(context, cursor);

  const builder = createActionBuilder();

  builder.addInstruction(instruction.spec.semantics, bindings, {
    eip: { external: externals.bind(context.locals.eip) },
    nextEip: { external: externals.bind(context.locals.nextEip) }
  });
  emitActionFragment(builder.finish(), {
    body: context.body,
    scratch: context.scratch,
    externalLocals: externals.locals,
    embedding: { success: { kind: "br", depth: context.continueDepth } }
  });
  context.handlers.push({ instructionId: instruction.spec.id, opcode: instruction.opcode, form });
}

type DecodedOperand = Readonly<{ binding: OperandBinding; cursor: DecodeCursor }>;

function decodeOperand(
  context: HandlerEmitContext,
  instruction: ExpandedInstructionSpec<SemanticTemplate>,
  operand: OperandSpec,
  form: HandlerForm,
  cursor: DecodeCursor,
  externals: HandlerExternals
): DecodedOperand {
  const { locals } = context;

  switch (operand.kind) {
    case "modrm.reg":
      return { binding: regDynamicBinding(externals.bind(locals.reg)), cursor };
    case "modrm.rm":
      assert(form !== "plain", `${instruction.spec.id}: rm operand without a resolved form`);
      return {
        binding:
          form === "memory"
            ? memExternalBinding(externals.bind(locals.address))
            : regDynamicBinding(externals.bind(locals.rm)),
        cursor
      };
    case "opcode.reg": {
      assert(
        instruction.opcodeLowBits !== undefined,
        `${instruction.spec.id}: opcode.reg operand without opcode low bits`
      );
      return { binding: regBinding(opcodeRegName(operand.type, instruction.opcodeLowBits)), cursor };
    }
    case "implicit.reg":
      return { binding: regBinding(operand.reg), cursor };
    case "imm":
      emitImmediateFetch(
        context,
        locals.eip,
        cursor,
        operand.width,
        operand.extension === "sign",
        locals.imm
      );
      return {
        binding: immExternalBinding(externals.bind(locals.imm)),
        cursor: advanceCursor(context, cursor, operand.width / 8)
      };
    case "rel": {
      assert(cursor.kind === "static", `${instruction.spec.id}: rel operand after a runtime-sized operand`);

      const length = cursor.offset + operand.width / 8;

      emitRelTargetFetch(context, locals.eip, cursor.offset, operand.width, length, locals.target);
      return {
        binding: immExternalBinding(externals.bind(locals.target)),
        cursor: { kind: "static", offset: length }
      };
    }
  }
}

function advanceCursor(context: HandlerEmitContext, cursor: DecodeCursor, byteLength: number): DecodeCursor {
  switch (cursor.kind) {
    case "static":
      return { kind: "static", offset: cursor.offset + byteLength };
    case "local":
      context.body.localGet(cursor.local).i32Const(byteLength).i32Add().localSet(cursor.local);
      return cursor;
  }
}

// nextEip is an external: eip plus the decoded length.
function emitNextEip(context: HandlerEmitContext, cursor: DecodeCursor): void {
  const { body, locals } = context;

  body.localGet(locals.eip);

  switch (cursor.kind) {
    case "static":
      body.i32Const(cursor.offset);
      break;
    case "local":
      body.localGet(cursor.local);
      break;
  }

  body.i32Add().localSet(locals.nextEip);
}

function opcodeRegName(type: RegOperandType, lowBits: number): RegName {
  const names: readonly RegName[] = opcodeRegNames(type);
  const name = names[lowBits];

  assert(name !== undefined, `opcode register low bits out of range: ${lowBits}`);
  return name;
}

function opcodeRegNames(type: RegOperandType): readonly RegName[] {
  switch (type) {
    case "r8":
      return reg8;
    case "r16":
      return reg16;
    case "r32":
      return reg32;
  }
}

// External ids per handler block, deduplicated per dispatch local.
class HandlerExternals {
  readonly locals = new Map<ExternalValueId, number>();
  readonly #idsByLocal = new Map<number, ExternalValueId>();

  bind(local: number): ExternalValueId {
    const existing = this.#idsByLocal.get(local);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.locals.size;

    this.locals.set(id, local);
    this.#idsByLocal.set(local, id);
    return id;
  }
}
