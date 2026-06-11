import { assert } from "#common/assert.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import {
  dispatchBytes,
  type OpcodeDispatchCandidateSet,
  type OpcodeDispatchLeaf,
  type OpcodeDispatchNode
} from "#x86/decoder/opcode-dispatch.js";
import type {
  ExpandedInstructionSpec,
  MemOperandType,
  ModRmMatch,
  OperandSpec,
  Reg3,
  RmOperandType
} from "#x86/schema/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import { emitRmMemoryAddressDecode } from "./decode.js";
import { emitModRmFetch, emitOpcodeByteFetch, type DecodeCursor } from "./fragments.js";
import { emitInstructionHandler, type HandlerEmitContext } from "./handlers.js";
import { actionInterpreterDispatchRoot } from "./instructions.js";

// The hand-written dispatch shape: br_table over the fetched opcode byte,
// the reg-field group switch, and the mod-form split. Every linear segment
// inside — fetches, address decode, handlers — is an action fragment.

export function emitActionOpcodeDispatch(context: HandlerEmitContext): void {
  emitDispatchNode(actionInterpreterDispatchRoot, context, 1);
}

function emitDispatchNode(node: OpcodeDispatchNode, context: HandlerEmitContext, opcodeLength: number): void {
  const { body } = context;
  const bytes = dispatchBytes(node);

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
    const child = node.next[byte];

    assert(child !== undefined, `opcode dispatch lost byte 0x${byte.toString(16)}`);

    const caseContext = { ...context, continueDepth: context.continueDepth + 1 + index };

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

function emitLeaf(leaf: OpcodeDispatchLeaf, context: HandlerEmitContext): void {
  const candidates = leaf.operandSize.default;

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
  context: HandlerEmitContext
): void {
  const { body, locals } = context;

  emitModRmFetch(context, locals.eip, leaf.opcodeLength, {
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
    emitModRmForms(cases[0]!.instruction, leaf, context);
    return;
  }

  for (let index = 0; index <= cases.length; index += 1) {
    body.block();
  }

  body.localGet(locals.reg).brTable(regDispatchTable(cases), cases.length);

  for (let index = cases.length - 1; index >= 0; index -= 1) {
    body.endBlock();
    emitModRmForms(cases[index]!.instruction, leaf, {
      ...context,
      continueDepth: context.continueDepth + 1 + index
    });
  }

  body.endBlock();
  emitReturnUnsupported(body);
}

// The two addressing forms of one instruction: mod 3 binds the rm register
// index, the rest decode an effective address.
function emitModRmForms(
  instruction: ExpandedInstructionSpec<SemanticTemplate>,
  leaf: OpcodeDispatchLeaf,
  context: HandlerEmitContext
): void {
  const { body } = context;
  const cursorAfterModRm: DecodeCursor = { kind: "static", offset: leaf.opcodeLength + 1 };
  const rmOperand = (instruction.spec.operands ?? []).find(isRmOperand);

  if (rmOperand === undefined) {
    emitInstructionHandler(context, instruction, "plain", cursorAfterModRm);
    return;
  }

  const armContext = { ...context, continueDepth: context.continueDepth + 1 };

  body.localGet(context.locals.mod).i32Const(3).i32Eq().ifBlock();

  if (isMemoryOnlyRmType(rmOperand.type)) {
    emitReturnUnsupported(body);
  } else {
    emitInstructionHandler(armContext, instruction, "register", cursorAfterModRm);
  }

  body.elseBlock();
  emitRmMemoryAddressDecode(armContext, leaf.opcodeLength);
  emitInstructionHandler(armContext, instruction, "memory", {
    kind: "local",
    local: context.locals.length
  });
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
    const instruction = bucket.find((candidate) => modRmRegMatches(candidate.spec.modrm?.match, reg));

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

function modRmRegMatches(match: ModRmMatch | undefined, reg: Reg3): boolean {
  return match?.reg === undefined || match.reg === reg;
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
  body.i64Const(encodeExit(ExitReason.UNSUPPORTED, 0)).returnFromFunction();
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
      return false;
  }
}

const reg3Values = [0, 1, 2, 3, 4, 5, 6, 7] as const satisfies readonly Reg3[];
