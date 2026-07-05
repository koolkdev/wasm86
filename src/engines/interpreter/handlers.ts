import { assert } from "#common/assert.js";
import { createIrBlockBuilder, externalInstructionLocation } from "#ir/builder.js";
import {
  immExternalBinding,
  dynamicMemSegment,
  memDynamicBinding,
  memStaticBinding,
  regBinding,
  regDynamicBinding,
  segmentBinding,
  segmentDynamicBinding,
  type ExternalValueId,
  type OperandBinding
} from "#ir/operands.js";
import type { ExpandedInstructionSpec, OperandSpec, RegOperandType } from "#x86/defs/spec.js";
import {
  defaultSegmentIndexForBaseIndex,
  dsSegmentIndex,
  noSegmentOverride,
  ssDefaultSegmentBaseIndexes,
  ssSegmentIndex
} from "#x86/segments.js";
import { reg32Index } from "#x86/registers.js";
import { reg16, reg32, reg8, type Reg32, type RegName } from "#x86/types.js";
import { wasmBranchHint, type WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import type { WasmHelperRegistry } from "#wasm/helpers/module.js";
import {
  emitImmediateFetch,
  emitRelTargetFetch,
  type DecodeCursor
} from "./fragments.js";
import type { InterpreterLocals } from "./locals.js";

// Instruction handlers are single-instruction IrBlocks over the existing
// semantics templates. Decoded operands arrive as externals — dynamic
// register indices, immediates, computed addresses — and eip/nextEip are
// externals too, so one handler body serves every register pair and address.

// The rm operand's resolved binding kind; "plain" has no rm operand.
export type HandlerForm = "plain" | "regDynamic" | "memStatic" | "memDynamic";

export type InterpreterHandler = Readonly<{
  instructionId: string;
  opcode: readonly number[];
  form: HandlerForm;
}>;

export type HandlerEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  locals: InterpreterLocals;
  helpers: WasmHelperRegistry;
  // Label depth from the emission point to the instruction-complete target.
  continueDepth: number;
  handlers: InterpreterHandler[];
}>;

export function emitInstructionHandler(
  context: HandlerEmitContext,
  instruction: ExpandedInstructionSpec,
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

  const builder = createIrBlockBuilder({ segmentMode: "flat32" });

  // The location's eip is what fault paths commit; prefix cases rebase the
  // eip local, so the location binds the saved instruction start.
  builder.addInstruction(
    instruction.spec.semantics,
    bindings,
    externalInstructionLocation(
      externals.bind(context.locals.instructionStart),
      externals.bind(context.locals.nextEip)
    )
  );
  emitActionFragment(builder.finish(), {
    body: context.body,
    scratch: context.scratch,
    externalLocals: externals.locals,
    helpers: context.helpers,
    embedding: { dispatch: { kind: "br", depth: context.continueDepth } }
  });
  context.handlers.push({ instructionId: instruction.spec.id, opcode: instruction.opcode, form });
}

type DecodedOperand = Readonly<{ binding: OperandBinding; cursor: DecodeCursor }>;

function decodeOperand(
  context: HandlerEmitContext,
  instruction: ExpandedInstructionSpec,
  operand: OperandSpec,
  form: HandlerForm,
  cursor: DecodeCursor,
  externals: HandlerExternals
): DecodedOperand {
  const { locals } = context;

  switch (operand.kind) {
    case "modrm.reg":
      return { binding: regDynamicBinding(externals.bind(locals.reg)), cursor };
    case "modrm.sreg":
      return { binding: segmentDynamicBinding(externals.bind(locals.reg)), cursor };
    case "modrm.rm":
      assert(form !== "plain", `${instruction.spec.id}: rm operand without a resolved form`);
      emitRmEffectiveSegment(context, form);
      return { binding: rmBinding(form, locals, externals), cursor };
    case "opcode.reg": {
      assert(
        instruction.opcodeLowBits !== undefined,
        `${instruction.spec.id}: opcode.reg operand without opcode low bits`
      );
      return { binding: regBinding(opcodeRegName(operand.type, instruction.opcodeLowBits)), cursor };
    }
    case "implicit.reg":
      return { binding: regBinding(operand.reg), cursor };
    case "implicit.sreg":
      return { binding: segmentBinding(operand.reg), cursor };
    case "implicit.mem":
      emitImplicitMemoryBinding(context, operand.base, operand.disp);
      return {
        binding: memDynamicBinding(
          externals.bind(locals.base),
          externals.bind(locals.offset),
          dynamicMemSegment(externals.bind(locals.effectiveSegment))
        ),
        cursor
      };
    case "moffs":
      cursor = emitImmediateFetch(context, locals.eip, cursor, 32, false, locals.offset);
      emitEffectiveSegment(context, dsSegmentIndex);
      return {
        binding: memStaticBinding(
          externals.bind(locals.offset),
          dynamicMemSegment(externals.bind(locals.effectiveSegment))
        ),
        cursor
      };
    case "imm":
      cursor = emitImmediateFetch(
        context,
        locals.eip,
        cursor,
        operand.width,
        operand.extension === "sign",
        locals.imm
      );
      return {
        binding: immExternalBinding(externals.bind(locals.imm)),
        cursor
      };
    case "rel":
      cursor = emitRelTargetFetch(context, locals.eip, cursor, operand.width, locals.target);
      return {
        binding: immExternalBinding(externals.bind(locals.target)),
        cursor
      };
  }
}

function emitImplicitMemoryBinding(
  context: HandlerEmitContext,
  base: Reg32,
  disp: number
): void {
  const { body, locals } = context;
  const baseIndex = reg32Index(base);

  body.i32Const(baseIndex).localSet(locals.base);
  body.i32Const(disp).localSet(locals.offset);
  emitEffectiveSegment(context, defaultSegmentIndexForBaseIndex(baseIndex));
}

// The base-less EA leaves decode complete in the offset local.
function rmBinding(
  form: Exclude<HandlerForm, "plain">,
  locals: InterpreterLocals,
  externals: HandlerExternals
): OperandBinding {
  switch (form) {
    case "regDynamic":
      return regDynamicBinding(externals.bind(locals.rm));
    case "memStatic":
      return memStaticBinding(
        externals.bind(locals.offset),
        dynamicMemSegment(externals.bind(locals.effectiveSegment))
      );
    case "memDynamic":
      return memDynamicBinding(
        externals.bind(locals.base),
        externals.bind(locals.offset),
        dynamicMemSegment(externals.bind(locals.effectiveSegment))
      );
  }
}

function emitRmEffectiveSegment(context: HandlerEmitContext, form: HandlerForm): void {
  switch (form) {
    case "plain":
    case "regDynamic":
      return;
    case "memStatic":
      emitEffectiveSegment(context, dsSegmentIndex);
      return;
    case "memDynamic":
      emitDynamicBaseEffectiveSegment(context);
      return;
  }
}

function emitEffectiveSegment(context: HandlerEmitContext, defaultSegment: number): void {
  const { body, locals } = context;

  body.localGet(locals.segment).i32Const(noSegmentOverride).i32Eq().ifBlock(wasmBranchHint.likely);
  body.i32Const(defaultSegment).localSet(locals.effectiveSegment);
  body.elseBlock();
  body.localGet(locals.segment).localSet(locals.effectiveSegment);
  body.endBlock();
}

function emitDynamicBaseEffectiveSegment(context: HandlerEmitContext): void {
  const { body, locals } = context;

  body.localGet(locals.segment).i32Const(noSegmentOverride).i32Eq().ifBlock(wasmBranchHint.likely);
  emitBaseDefaultsToStackSegment(context);
  body.ifBlock();
  body.i32Const(ssSegmentIndex).localSet(locals.effectiveSegment);
  body.elseBlock();
  body.i32Const(dsSegmentIndex).localSet(locals.effectiveSegment);
  body.endBlock();
  body.elseBlock();
  body.localGet(locals.segment).localSet(locals.effectiveSegment);
  body.endBlock();
}

function emitBaseDefaultsToStackSegment(context: HandlerEmitContext): void {
  const { body, locals } = context;
  const [firstBaseIndex, ...remainingBaseIndexes] = ssDefaultSegmentBaseIndexes;

  body.localGet(locals.base).i32Const(firstBaseIndex).i32Eq();

  for (const baseIndex of remainingBaseIndexes) {
    body.localGet(locals.base).i32Const(baseIndex).i32Eq().i32Or();
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
