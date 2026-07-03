import { assert } from "#common/assert.js";
import type { SemanticTemplate } from "#x86/semantics/builder.js";
import {
  dispatchBytes,
  type OpcodeDispatchCandidateSet,
  type OpcodeDispatchLeaf,
  type OpcodeDispatchNode
} from "#x86/decoder/opcode-dispatch.js";
import type {
  ExpandedInstructionSpec,
  MemOperandType,
  OperandSizePrefixMode,
  OperandSpec,
  Reg3,
  RmOperandType
} from "#x86/schema/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { segmentRegisters } from "#x86/types.js";
import { encodeHostExit, HostExit } from "#wasm/exit.js";
import { noBaseRegister, type RmDecodeHelpers } from "./decode.js";
import { emitModRmFetch, emitOpcodeByteFetch, type DecodeCursor } from "./fragments.js";
import { emitInstructionHandler, type HandlerEmitContext } from "./handlers.js";
import { interpreterDispatchRoot } from "./instructions.js";

// The hand-written dispatch shape: br_table over the fetched opcode byte,
// the reg-field group switch, and the mod-form split. Fetches and handlers
// are action fragments; memory arms call the shared rm-decode helper.
//
// The operand-size prefix dispatches positionally, canonical encodings only:
// 0x66 at the first byte is one more dispatch case that fetches the next
// byte and re-enters the root with the override candidate sets, the prefix
// counted in the opcode length. Anything else — repeated prefixes, prefixes
// on multi-byte positions — falls through dispatch to the honest
// unsupported exit.

const operandSizeOverridePrefix = 0x66;

export type DispatchEmitContext = HandlerEmitContext & Readonly<{ rmDecode: RmDecodeHelpers }>;

type OpcodeDispatchContext = DispatchEmitContext &
  Readonly<{
    operandSize: OperandSizePrefixMode;
    // Prefix bytes before the opcode (0 or 1); leaf byte offsets shift by it.
    prefixLength: number;
  }>;

export function emitOpcodeDispatch(context: DispatchEmitContext): void {
  emitDispatchNode(interpreterDispatchRoot, { ...context, operandSize: "default", prefixLength: 0 }, 1);
}

function emitDispatchNode(node: OpcodeDispatchNode, context: OpcodeDispatchContext, opcodeLength: number): void {
  const { body } = context;
  const bytes = dispatchBytesWithPrefix(node, prefixDispatches(context, opcodeLength));

  if (bytes.length === 0) {
    emitReturnUnsupported(body);
    return;
  }

  for (let index = 0; index <= bytes.length; index += 1) {
    body.block();
  }

  body.localGet(context.locals.byte).brTable(byteDispatchTable(bytes), bytes.length);

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    body.endBlock();

    const byte = bytes[index]!;
    const caseContext = { ...context, continueDepth: context.continueDepth + 1 + index };

    if (byte === operandSizeOverridePrefix && prefixDispatches(context, opcodeLength)) {
      emitOperandSizePrefixCase(caseContext);
      continue;
    }

    const child = node.next[byte];

    assert(child !== undefined, `opcode dispatch lost byte 0x${byte.toString(16)}`);

    if (child.leaf !== undefined) {
      emitLeaf(child.leaf, caseContext);
    } else {
      emitOpcodeByteFetch(caseContext, context.locals.eip, opcodeLength, context.locals.byte);
      emitDispatchNode(child, caseContext, opcodeLength + 1);
    }
  }

  body.endBlock();
  emitReturnUnsupported(body);
}

// The prefix is a first-byte dispatch case of the unprefixed root only.
function prefixDispatches(context: OpcodeDispatchContext, opcodeLength: number): boolean {
  return context.operandSize === "default" && opcodeLength === 1;
}

function dispatchBytesWithPrefix(node: OpcodeDispatchNode, withPrefix: boolean): number[] {
  const bytes = dispatchBytes(node);

  if (!withPrefix) {
    return bytes;
  }

  assert(
    !bytes.includes(operandSizeOverridePrefix),
    "the operand-size prefix byte collides with an opcode"
  );
  return [...bytes, operandSizeOverridePrefix];
}

// The byte after the prefix is the opcode: fetch it and re-enter the root
// dispatch over the override candidate sets.
function emitOperandSizePrefixCase(context: OpcodeDispatchContext): void {
  emitOpcodeByteFetch(context, context.locals.eip, 1, context.locals.byte);
  emitDispatchNode(
    interpreterDispatchRoot,
    { ...context, operandSize: "override", prefixLength: 1 },
    2
  );
}

function emitLeaf(leaf: OpcodeDispatchLeaf, context: OpcodeDispatchContext): void {
  const candidates = leaf.operandSize[context.operandSize];

  switch (candidates.kind) {
    case "empty":
      emitReturnUnsupported(context.body);
      return;
    case "noModRm": {
      const instruction = candidates.noModRmCandidates[0];

      if (instruction === undefined) {
        emitReturnUnsupported(context.body);
        return;
      }

      emitInstructionHandler(context, instruction, "plain", {
        kind: "static",
        offset: context.prefixLength + leaf.opcodeLength
      });
      return;
    }
    case "modRm":
      emitModRmLeaf(leaf, candidates, context);
      return;
  }
}

function emitModRmLeaf(
  leaf: OpcodeDispatchLeaf,
  candidates: OpcodeDispatchCandidateSet,
  context: OpcodeDispatchContext
): void {
  const { body, locals } = context;
  const opcodeEnd = context.prefixLength + leaf.opcodeLength;

  emitModRmFetch(context, locals.eip, opcodeEnd, {
    modLocal: locals.mod,
    regLocal: locals.reg,
    rmLocal: locals.rm
  });

  const cases = modRmRegCases(candidates);

  if (cases.length === 0) {
    emitReturnUnsupported(body);
    return;
  }

  if (cases.length === 1 && cases[0]!.regs.length === reg3Values.length) {
    emitModRmForms(cases[0]!.instruction, opcodeEnd, context);
    return;
  }

  for (let index = 0; index <= cases.length; index += 1) {
    body.block();
  }

  body.localGet(locals.reg).brTable(regDispatchTable(cases), cases.length);

  for (let index = cases.length - 1; index >= 0; index -= 1) {
    body.endBlock();
    emitModRmForms(cases[index]!.instruction, opcodeEnd, {
      ...context,
      continueDepth: context.continueDepth + 1 + index
    });
  }

  body.endBlock();
  emitReturnUnsupported(body);
}

// The addressing forms of one instruction: mod 3 binds the rm register
// index, the rest decode an effective address and base presence picks the
// memStatic or memDynamic body.
function emitModRmForms(
  instruction: ExpandedInstructionSpec<SemanticTemplate>,
  opcodeEnd: number,
  context: DispatchEmitContext
): void {
  const { body } = context;
  const cursorAfterModRm: DecodeCursor = { kind: "static", offset: opcodeEnd + 1 };
  const rmOperand = (instruction.spec.operands ?? []).find(isRmOperand);

  if (rmOperand === undefined) {
    emitInstructionHandler(context, instruction, "plain", cursorAfterModRm);
    return;
  }

  const armContext = { ...context, continueDepth: context.continueDepth + 1 };
  const memoryContext = { ...context, continueDepth: context.continueDepth + 2 };
  const cursorAfterAddress: DecodeCursor = { kind: "local", local: context.locals.length };

  body.localGet(context.locals.mod).i32Const(3).i32Eq().ifBlock();

  if (isMemoryOnlyRmType(rmOperand.type)) {
    emitReturnUnsupported(body);
  } else {
    emitInstructionHandler(armContext, instruction, "regDynamic", cursorAfterModRm);
  }

  body.elseBlock();
  armContext.rmDecode.emitMemoryAddressDecode(armContext, opcodeEnd);
  body.localGet(context.locals.base).i32Const(noBaseRegister).i32Eq().ifBlock();
  emitInstructionHandler(memoryContext, instruction, "memStatic", cursorAfterAddress);
  body.elseBlock();
  emitInstructionHandler(memoryContext, instruction, "memDynamic", cursorAfterAddress);
  body.endBlock();
  body.endBlock();
}

type ModRmRegCase = Readonly<{
  instruction: ExpandedInstructionSpec<SemanticTemplate>;
  regs: readonly Reg3[];
}>;

function modRmRegCases(candidates: OpcodeDispatchCandidateSet): readonly ModRmRegCase[] {
  const casesById = new Map<string, { instruction: ExpandedInstructionSpec<SemanticTemplate>; regs: Reg3[] }>();

  for (const reg of reg3Values) {
    const bucket = candidates.modRmByReg[reg] ?? [];
    const instruction = bucket.find((candidate) => modRmRegMatches(candidate.spec, reg));

    if (instruction === undefined) {
      continue;
    }

    const existing = casesById.get(instruction.spec.id);

    if (existing === undefined) {
      casesById.set(instruction.spec.id, { instruction, regs: [reg] });
    } else {
      existing.regs.push(reg);
    }
  }

  return [...casesById.values()];
}

function modRmRegMatches(spec: ExpandedInstructionSpec<SemanticTemplate>["spec"], reg: Reg3): boolean {
  return (spec.modrm?.match?.reg === undefined || spec.modrm.match.reg === reg) && isValidModRmReg(spec, reg);
}

function isValidModRmReg(spec: ExpandedInstructionSpec<SemanticTemplate>["spec"], reg: Reg3): boolean {
  return !(spec.operands ?? []).some((operand) => operand.kind === "modrm.sreg") || reg < segmentRegisters.length;
}

function byteDispatchTable(bytes: readonly number[]): number[] {
  const table = new Array<number>(256).fill(bytes.length);

  for (const [index, byte] of bytes.entries()) {
    table[byte] = bytes.length - 1 - index;
  }

  return table;
}

function regDispatchTable(cases: readonly ModRmRegCase[]): number[] {
  const table = new Array<number>(reg3Values.length).fill(cases.length);

  for (const [index, dispatchCase] of cases.entries()) {
    for (const reg of dispatchCase.regs) {
      table[reg] = cases.length - 1 - index;
    }
  }

  return table;
}

function emitReturnUnsupported(body: WasmFunctionBodyEncoder): void {
  body.i64Const(encodeHostExit(HostExit.UNSUPPORTED, 0)).returnFromFunction();
}

function isRmOperand(operand: OperandSpec): operand is Extract<OperandSpec, { kind: "modrm.rm" }> {
  return operand.kind === "modrm.rm";
}

function isMemoryOnlyRmType(type: RmOperandType | MemOperandType): type is MemOperandType {
  switch (type) {
    case "m8":
    case "m16":
    case "m32":
      return true;
    case "rm8":
    case "rm16":
    case "rm32":
    case "r32_m16":
      return false;
  }
}

const reg3Values = [0, 1, 2, 3, 4, 5, 6, 7] as const satisfies readonly Reg3[];
