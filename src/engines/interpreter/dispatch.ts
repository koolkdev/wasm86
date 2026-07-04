import { assert } from "#common/assert.js";
import {
  dispatchBytes,
  type OpcodeDispatchCandidateSet,
  type OpcodeDispatchLeaf,
  type OpcodeDispatchNode
} from "#x86/decoder/opcode-dispatch.js";
import type {
  ExpandedInstructionSpec,
  MemOperandType,
  OperandSpec,
  Reg3,
  RmOperandType
} from "#x86/defs/spec.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { segmentRegisters } from "#x86/types.js";
import { encodeHostExit, HostExit } from "#wasm/exit.js";
import { noBaseRegister, type RmDecodeHelpers } from "./decode.js";
import { emitModRmFetch, emitOpcodeByteFetch, type DecodeCursor } from "./fragments.js";
import { emitInstructionHandler, type HandlerEmitContext } from "./handlers.js";
import { interpreterDispatchRoot } from "./instructions.js";
import { emitPrefixCase, operandSizeFlagBit, prefixBytes } from "./prefixes.js";

// The hand-written dispatch shape: br_table over the fetched opcode byte,
// the reg-field group switch, and the mod-form split. Fetches and handlers
// are action fragments; memory arms call the shared rm-decode helper.
//
// The tree is emitted once, inside the run loop's redispatch loop. Prefix
// bytes are first-byte cases that consume their byte and branch back to
// rescan (prefixes.ts), so dispatch reaches the opcode with the eip local
// rebased to it — every decode offset stays static — and each leaf picks
// its arm by the prefix flags.

export type DispatchEmitContext = HandlerEmitContext & Readonly<{ rmDecode: RmDecodeHelpers }>;

export function emitOpcodeDispatch(context: DispatchEmitContext): void {
  emitDispatchNode(interpreterDispatchRoot, context, 1);
}

// One dispatch case: an opcode child of the tree, or a prefix byte that
// consumes itself and branches back to rescan.
type DispatchCase =
  | Readonly<{ byte: number; kind: "opcode"; child: OpcodeDispatchNode }>
  | Readonly<{ byte: number; kind: "prefix" }>;

function dispatchCases(node: OpcodeDispatchNode, opcodeLength: number): DispatchCase[] {
  const cases: DispatchCase[] = dispatchBytes(node).map((byte) => {
    const child = node.next[byte];

    assert(child !== undefined, `opcode dispatch lost byte 0x${byte.toString(16)}`);
    return { byte, kind: "opcode", child };
  });

  // Prefix bytes dispatch at the first byte only: deeper bytes are opcode
  // bytes, and a prefix case has already consumed anything before them.
  if (opcodeLength > 1) {
    return cases;
  }

  for (const byte of prefixBytes) {
    assert(node.next[byte] === undefined, "a prefix byte collides with an opcode");
    cases.push({ byte, kind: "prefix" });
  }

  return cases;
}

function emitDispatchNode(node: OpcodeDispatchNode, context: DispatchEmitContext, opcodeLength: number): void {
  const { body } = context;
  const cases = dispatchCases(node, opcodeLength);

  if (cases.length === 0) {
    emitReturnUnsupported(body);
    return;
  }

  for (let index = 0; index <= cases.length; index += 1) {
    body.block();
  }

  body.localGet(context.locals.byte).brTable(byteDispatchTable(cases), cases.length);

  for (let index = cases.length - 1; index >= 0; index -= 1) {
    body.endBlock();
    emitDispatchCase(cases[index]!, {
      ...context,
      continueDepth: context.continueDepth + 1 + index
    }, opcodeLength);
  }

  body.endBlock();
  emitReturnUnsupported(body);
}

function emitDispatchCase(
  dispatchCase: DispatchCase,
  context: DispatchEmitContext,
  opcodeLength: number
): void {
  switch (dispatchCase.kind) {
    case "prefix":
      // The redispatch loop sits one label inside the instruction-complete
      // target.
      emitPrefixCase(dispatchCase.byte, context.continueDepth - 1, context);
      return;
    case "opcode": {
      const { child } = dispatchCase;

      if (child.leaf !== undefined) {
        emitLeaf(child.leaf, context);
        return;
      }

      emitOpcodeByteFetch(context, context.locals.eip, opcodeLength, context.locals.byte);
      emitDispatchNode(child, context, opcodeLength + 1);
      return;
    }
  }
}

// One arm per operand-size bucket, indexed by the masked prefix flags; an
// empty bucket's arm is the unsupported exit.
function emitLeaf(leaf: OpcodeDispatchLeaf, context: DispatchEmitContext): void {
  const { body, locals } = context;
  const arms = [leaf.operandSize.default, leaf.operandSize.override];

  for (let index = 0; index < arms.length; index += 1) {
    body.block();
  }

  body.localGet(locals.prefixFlags).i32Const(operandSizeFlagBit).i32And();
  // The mask keeps the value inside the table; the default is unreachable.
  body.brTable(arms.map((_, value) => arms.length - 1 - value), 0);

  for (let value = arms.length - 1; value >= 0; value -= 1) {
    body.endBlock();
    emitLeafCandidates(leaf, arms[value]!, {
      ...context,
      continueDepth: context.continueDepth + value
    });
  }
}

function emitLeafCandidates(
  leaf: OpcodeDispatchLeaf,
  candidates: OpcodeDispatchCandidateSet,
  context: DispatchEmitContext
): void {
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
        offset: leaf.opcodeLength
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
  context: DispatchEmitContext
): void {
  const { body, locals } = context;
  const opcodeEnd = leaf.opcodeLength;

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
  instruction: ExpandedInstructionSpec,
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
  instruction: ExpandedInstructionSpec;
  regs: readonly Reg3[];
}>;

function resolvedModRmCandidate(
  candidates: OpcodeDispatchCandidateSet,
  reg: Reg3
): ExpandedInstructionSpec | undefined {
  return (candidates.modRmByReg[reg] ?? []).find((candidate) => modRmRegMatches(candidate.spec, reg));
}

function modRmRegCases(candidates: OpcodeDispatchCandidateSet): readonly ModRmRegCase[] {
  const casesById = new Map<string, { instruction: ExpandedInstructionSpec; regs: Reg3[] }>();

  for (const reg of reg3Values) {
    const instruction = resolvedModRmCandidate(candidates, reg);

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

function modRmRegMatches(spec: ExpandedInstructionSpec["spec"], reg: Reg3): boolean {
  return (spec.modrm?.match?.reg === undefined || spec.modrm.match.reg === reg) && isValidModRmReg(spec, reg);
}

function isValidModRmReg(spec: ExpandedInstructionSpec["spec"], reg: Reg3): boolean {
  return !(spec.operands ?? []).some((operand) => operand.kind === "modrm.sreg") || reg < segmentRegisters.length;
}

function byteDispatchTable(cases: readonly DispatchCase[]): number[] {
  const table = new Array<number>(256).fill(cases.length);

  for (const [index, dispatchCase] of cases.entries()) {
    table[dispatchCase.byte] = cases.length - 1 - index;
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
