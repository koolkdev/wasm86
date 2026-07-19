import { assert } from "#common/assert.js";
import { externalInstructionLocation } from "#core/instruction/builder.js";
import { createLegacyInstructionBlock } from "#engines/legacy-instruction-block.js";
import {
  immExternalBinding,
  dynamicMemSegment,
  memBinding,
  memDynamicBinding,
  memStaticBinding,
  regBinding,
  regDynamicBinding,
  segmentBinding,
  segmentDynamicBinding,
  staticMemSegment,
  type OperandBinding
} from "#core/instruction/bindings.js";
import type { ExternalValueId } from "#compiler/ir/values/types.js";
import type { ExpandedInstructionSpec, OperandSpec, RegOperandType } from "#core/isa/spec.js";
import {
  defaultSegmentIndexForBaseIndex,
  dsSegmentIndex,
  noSegmentOverride,
  ssDefaultSegmentBaseIndexes,
  ssSegmentIndex
} from "#core/segments.js";
import { reg32Index } from "#core/registers.js";
import { reg16, reg32, reg8, type Reg32, type RegName, type SegmentRegister } from "#core/types.js";
import { wasmBranchHint, type WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import type { ModuleBindings } from "#compiler/program/bindings.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import {
  emitImmediateFetch,
  emitRelTargetFetch,
  type DecodeCursor
} from "./fragments.js";
import {
  withHandlerScratch,
  withValueOperandScratch,
  type HandlerScratch,
  type InterpreterLocals,
  type ModRmScratch,
  type RmAddressScratch
} from "./locals.js";

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
  bindings: ModuleBindings;
  locals: InterpreterLocals;
  // Label depth from the emission point to the instruction-complete target.
  continueDepth: number;
  handlers: InterpreterHandler[];
}>;

export type HandlerCase =
  | Readonly<{ form: "plain"; modRm?: ModRmScratch }>
  | Readonly<{ form: "regDynamic"; modRm: ModRmScratch }>
  | Readonly<{ form: "memStatic"; modRm: ModRmScratch; address: RmAddressScratch }>
  | Readonly<{ form: "memDynamic"; modRm: ModRmScratch; address: RmAddressScratch }>;

export function emitInstructionHandler(
  context: HandlerEmitContext,
  instruction: ExpandedInstructionSpec,
  handlerCase: HandlerCase,
  cursorAfterDispatch: DecodeCursor
): void {
  const operands = instruction.spec.operands ?? [];

  withHandlerScratch(context.scratch, (handlerScratch) => {
    withValueOperandScratch(context.scratch, valueOperandCount(operands), (valueScratch) => {
      const externals = new HandlerExternals();
      const emittedOperands = new HandlerOperandEmitter(
        context,
        instruction,
        handlerCase,
        cursorAfterDispatch,
        handlerScratch,
        valueScratch,
        externals
      ).emitAll();

      emitNextEip(context, emittedOperands.cursor, handlerScratch.nextEip);

      const builder = createLegacyInstructionBlock({ segmentMode: "flat32" });

      // The location's eip is what fault paths commit; prefix cases rebase the
      // eip local, so the location binds the saved instruction start.
      builder.add(
        instruction.spec.semantics,
        emittedOperands.bindings,
        externalInstructionLocation(
          externals.bind(context.locals.instructionStart),
          externals.bind(handlerScratch.nextEip)
        )
      );
      emitActionFragment(builder.finish(), {
        body: context.body,
        scratch: context.scratch,
        externalLocals: externals.locals,
        bindings: context.bindings,
        embedding: { dispatch: { kind: "br", depth: context.continueDepth } }
      });
      context.handlers.push({
        instructionId: instruction.spec.id,
        opcode: instruction.opcode,
        form: handlerCase.form
      });
    });
  });
}

type EmittedHandlerOperands = Readonly<{
  bindings: readonly OperandBinding[];
  cursor: DecodeCursor;
}>;

class HandlerOperandEmitter {
  readonly #context: HandlerEmitContext;
  readonly #instruction: ExpandedInstructionSpec;
  readonly #operands: readonly OperandSpec[];
  readonly #handlerCase: HandlerCase;
  readonly #handlerScratch: HandlerScratch;
  readonly #valueScratch: readonly number[];
  readonly #externals: HandlerExternals;
  readonly #bindings: OperandBinding[] = [];
  #cursor: DecodeCursor;
  #valueIndex = 0;

  constructor(
    context: HandlerEmitContext,
    instruction: ExpandedInstructionSpec,
    handlerCase: HandlerCase,
    cursor: DecodeCursor,
    handlerScratch: HandlerScratch,
    valueScratch: readonly number[],
    externals: HandlerExternals
  ) {
    this.#context = context;
    this.#instruction = instruction;
    this.#operands = instruction.spec.operands ?? [];
    this.#handlerCase = handlerCase;
    this.#cursor = cursor;
    this.#handlerScratch = handlerScratch;
    this.#valueScratch = valueScratch;
    this.#externals = externals;
  }

  emitAll(): EmittedHandlerOperands {
    for (const operand of this.#operands) {
      this.#bindings.push(this.#emitOperand(operand));
    }

    assert(
      this.#valueIndex === this.#valueScratch.length,
      `${this.#instruction.spec.id}: not all value scratch locals were consumed`
    );

    return { bindings: this.#bindings, cursor: this.#cursor };
  }

  #emitOperand(operand: OperandSpec): OperandBinding {
    const { locals } = this.#context;

    switch (operand.kind) {
      case "modrm.reg":
        return regDynamicBinding(this.#external(this.#modRmScratch().reg));
      case "modrm.sreg":
        return segmentDynamicBinding(this.#external(this.#modRmScratch().reg));
      case "modrm.rm":
        this.#emitRmEffectiveSegment();
        return this.#rmBinding();
      case "opcode.reg": {
        assert(
          this.#instruction.opcodeLowBits !== undefined,
          `${this.#instruction.spec.id}: opcode.reg operand without opcode low bits`
        );
        return regBinding(opcodeRegName(operand.type, this.#instruction.opcodeLowBits));
      }
      case "implicit.reg":
        return regBinding(operand.reg);
      case "implicit.sreg":
        return segmentBinding(operand.reg);
      case "implicit.mem":
        return this.#implicitMemoryBinding(operand.base, operand.disp, operand.segment);
      case "moffs":
        this.#cursor = emitImmediateFetch(
          this.#context,
          locals.eip,
          this.#cursor,
          32,
          false,
          this.#handlerScratch.offset
        );
        emitEffectiveSegment(this.#context, dsSegmentIndex, this.#handlerScratch.effectiveSegment);
        return memStaticBinding(
          this.#external(this.#handlerScratch.offset),
          dynamicMemSegment(this.#external(this.#handlerScratch.effectiveSegment))
        );
      case "imm": {
        const valueLocal = this.#nextValueLocal();

        this.#cursor = emitImmediateFetch(
          this.#context,
          locals.eip,
          this.#cursor,
          operand.width,
          operand.extension === "sign",
          valueLocal
        );
        return immExternalBinding(this.#external(valueLocal));
      }
      case "rel": {
        const valueLocal = this.#nextValueLocal();

        this.#cursor = emitRelTargetFetch(this.#context, locals.eip, this.#cursor, operand.width, valueLocal);
        return immExternalBinding(this.#external(valueLocal));
      }
    }
  }

  #implicitMemoryBinding(
    base: Reg32,
    disp: number,
    segment: SegmentRegister | undefined
  ): OperandBinding {
    if (segment !== undefined) {
      return memBinding(
        { base, index: undefined, scale: 1, disp },
        staticMemSegment(segment)
      );
    }

    emitEffectiveSegment(
      this.#context,
      defaultSegmentIndexForBaseIndex(reg32Index(base)),
      this.#handlerScratch.effectiveSegment
    );
    return memBinding(
      { base, index: undefined, scale: 1, disp },
      dynamicMemSegment(this.#external(this.#handlerScratch.effectiveSegment))
    );
  }

  #rmBinding(): OperandBinding {
    switch (this.#handlerCase.form) {
      case "regDynamic":
        return regDynamicBinding(this.#external(this.#handlerCase.modRm.rm));
      case "memStatic":
        return memStaticBinding(
          this.#external(this.#handlerCase.address.offset),
          dynamicMemSegment(this.#external(this.#handlerScratch.effectiveSegment))
        );
      case "memDynamic":
        return memDynamicBinding(
          this.#external(this.#handlerCase.address.base),
          this.#external(this.#handlerCase.address.offset),
          dynamicMemSegment(this.#external(this.#handlerScratch.effectiveSegment))
        );
      case "plain":
        assert(false, `${this.#instruction.spec.id}: rm operand without a resolved form`);
    }
  }

  #emitRmEffectiveSegment(): void {
    switch (this.#handlerCase.form) {
      case "plain":
      case "regDynamic":
        return;
      case "memStatic":
        emitEffectiveSegment(this.#context, dsSegmentIndex, this.#handlerScratch.effectiveSegment);
        return;
      case "memDynamic":
        emitDynamicBaseEffectiveSegment(
          this.#context,
          this.#handlerCase.address.base,
          this.#handlerScratch.effectiveSegment
        );
        return;
    }
  }

  #modRmScratch(): ModRmScratch {
    const { modRm } = this.#handlerCase;

    assert(modRm !== undefined, `${this.#instruction.spec.id}: ModRM operand without ModRM scratch`);
    return modRm;
  }

  #nextValueLocal(): number {
    const local = this.#valueScratch[this.#valueIndex];

    assert(local !== undefined, `${this.#instruction.spec.id}: value scratch ${this.#valueIndex} was not allocated`);
    this.#valueIndex += 1;
    return local;
  }

  #external(local: number): ExternalValueId {
    return this.#externals.bind(local);
  }
}

function emitEffectiveSegment(context: HandlerEmitContext, defaultSegment: number, effectiveSegmentLocal: number): void {
  const { body, locals } = context;

  body.localGet(locals.segment).i32Const(noSegmentOverride).i32Eq().ifBlock({ hint: wasmBranchHint.likely });
  body.i32Const(defaultSegment).localSet(effectiveSegmentLocal);
  body.elseBlock();
  body.localGet(locals.segment).localSet(effectiveSegmentLocal);
  body.endBlock();
}

function emitDynamicBaseEffectiveSegment(
  context: HandlerEmitContext,
  baseLocal: number,
  effectiveSegmentLocal: number
): void {
  const { body, locals } = context;

  body.localGet(locals.segment).i32Const(noSegmentOverride).i32Eq().ifBlock({ hint: wasmBranchHint.likely });
  emitBaseDefaultsToStackSegment(context, baseLocal);
  body.ifBlock();
  body.i32Const(ssSegmentIndex).localSet(effectiveSegmentLocal);
  body.elseBlock();
  body.i32Const(dsSegmentIndex).localSet(effectiveSegmentLocal);
  body.endBlock();
  body.elseBlock();
  body.localGet(locals.segment).localSet(effectiveSegmentLocal);
  body.endBlock();
}

function emitBaseDefaultsToStackSegment(context: HandlerEmitContext, baseLocal: number): void {
  const { body } = context;
  const [firstBaseIndex, ...remainingBaseIndexes] = ssDefaultSegmentBaseIndexes;

  body.localGet(baseLocal).i32Const(firstBaseIndex).i32Eq();

  for (const baseIndex of remainingBaseIndexes) {
    body.localGet(baseLocal).i32Const(baseIndex).i32Eq().i32Or();
  }
}

// nextEip is an external: eip plus the decoded length.
function emitNextEip(context: HandlerEmitContext, cursor: DecodeCursor, nextEipLocal: number): void {
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

  body.i32Add().localSet(nextEipLocal);
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

function valueOperandCount(operands: readonly OperandSpec[]): number {
  return operands.filter(isValueOperand).length;
}

function isValueOperand(operand: OperandSpec): boolean {
  return operand.kind === "imm" || operand.kind === "rel";
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
