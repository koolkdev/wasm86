import { buildIr } from "#x86/ir/build/builder.js";
import type { ExpandedInstructionSpec, ModRmMatch, Reg3 } from "#x86/isa/schema/types.js";
import type { OpcodeDispatchCandidateSet, OpcodeDispatchLeaf } from "#x86/isa/decoder/opcode-dispatch.js";
import type { SemanticTemplate } from "#x86/ir/model/types.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import {
  emitInterpreterIrWithContext,
  interpreterSemanticOperandInfo
} from "#backends/wasm/interpreter/codegen/ir-context.js";
import type { InterpreterHandlerContext } from "#backends/wasm/interpreter/codegen/handler-context.js";
import { emitModRmDispatch, type ModRmDispatchCase } from "./modrm-dispatch.js";
import { decodeInstructionOperands } from "#backends/wasm/interpreter/decode/operand-decode.js";
import { emitReadGuestByteAtRelativeOffset } from "#backends/wasm/interpreter/decode/decode-reader.js";

export function emitInstructionHandlerForLeaf(
  leaf: OpcodeDispatchLeaf,
  context: InterpreterHandlerContext
): boolean {
  const candidates = leaf.operandSize[context.operandSize];

  switch (candidates.kind) {
    case "empty":
      return false;
    case "noModRm": {
      const noModRmInstruction = candidates.noModRmCandidates[0];

      if (noModRmInstruction === undefined) {
        return false;
      }

      emitInstructionHandler(noModRmInstruction, context, undefined);
      return true;
    }
    case "modRm":
      return emitModRmInstructionHandler(leaf, candidates, context);
  }
}

function emitModRmInstructionHandler(
  leaf: OpcodeDispatchLeaf,
  candidates: OpcodeDispatchCandidateSet,
  context: InterpreterHandlerContext
): boolean {
  const modRmCases = registerModRmDispatchCases(candidates);

  if (modRmCases.length === 0) {
    return false;
  }

  const modRmLocal = context.scratch.allocLocal(wasmValueType.i32);

  try {
    emitReadGuestByteAtRelativeOffset(context, context.opcodeOffset, leaf.opcodeLength, modRmLocal);

    if (modRmCases.length === 1 && modRmCases[0]?.regs.length === reg3Values.length) {
      emitInstructionHandler(modRmCases[0].instruction, context, modRmLocal);
      return true;
    }

    emitModRmDispatch(
      context.body,
      context.exit,
      modRmLocal,
      bindModRmCases(modRmCases, context, modRmLocal)
    );
  } finally {
    context.scratch.freeLocal(modRmLocal);
  }

  return true;
}

function emitInstructionHandler(
  instruction: ExpandedInstructionSpec<SemanticTemplate>,
  context: InterpreterHandlerContext,
  modRmLocal: number | undefined
): void {
  const decoded = decodeInstructionOperands(instruction, context, modRmLocal);
  const program = buildIr(instruction.spec.semantics, {
    operandInfo: decoded.operands.map(interpreterSemanticOperandInfo)
  });

  try {
    emitInterpreterIrWithContext(program, {
      body: context.body,
      scratch: context.scratch,
      state: context.state,
      locals: context.locals,
      exit: context.exit,
      depths: context.depths,
      instructionLength: decoded.instructionLength,
      operands: decoded.operands
    });
  } finally {
    for (const local of decoded.scratchLocals) {
      context.scratch.freeLocal(local);
    }
  }
}

type ModRmCaseSpec = Readonly<{
  instruction: ExpandedInstructionSpec<SemanticTemplate>;
  regs: readonly Reg3[];
}>;

function registerModRmDispatchCases(candidates: OpcodeDispatchCandidateSet): readonly ModRmCaseSpec[] {
  const casesByInstruction = new Map<string, { instruction: ExpandedInstructionSpec<SemanticTemplate>; regs: Reg3[] }>();

  for (const reg of reg3Values) {
    const instruction = supportedRegisterModRmInstruction(candidates, reg);

    if (instruction === undefined) {
      continue;
    }

    const existing = casesByInstruction.get(instruction.spec.id);

    if (existing === undefined) {
      casesByInstruction.set(instruction.spec.id, { instruction, regs: [reg] });
    } else {
      existing.regs.push(reg);
    }
  }

  return [...casesByInstruction.values()];
}

function bindModRmCases(
  cases: readonly ModRmCaseSpec[],
  context: InterpreterHandlerContext,
  modRmLocal: number
): readonly ModRmDispatchCase[] {
  return cases.map((dispatchCase, index) => ({
    regs: dispatchCase.regs,
    emit: () => {
      emitInstructionHandler(
        dispatchCase.instruction,
        {
          ...context,
          depths: context.depths.caseBranch(index),
          exit: {
            ...context.exit,
            labelDepth: context.exit.labelDepth + 1 + index
          }
        },
        modRmLocal
      );
    }
  }));
}

function supportedRegisterModRmInstruction(
  candidates: OpcodeDispatchCandidateSet,
  reg: Reg3
): ExpandedInstructionSpec<SemanticTemplate> | undefined {
  const bucket = candidates.modRmByReg[reg] ?? [];

  return bucket.find((candidate) => modRmRegMatches(candidate.spec.modrm?.match, reg));
}

function modRmRegMatches(match: ModRmMatch | undefined, reg: Reg3): boolean {
  if (match === undefined) {
    return true;
  }

  return match.reg === undefined || match.reg === reg;
}

const reg3Values = [0, 1, 2, 3, 4, 5, 6, 7] as const satisfies readonly Reg3[];
