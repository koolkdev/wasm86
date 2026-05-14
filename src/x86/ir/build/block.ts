import { IrEmitter, type IrBlockTerminator } from "./emitter.js";
import { irVar } from "#x86/ir/model/refs.js";
import type {
  OperandRef,
  SemanticOperandInfo,
  SemanticTemplate,
  IrOp,
  IrBlock,
  VarRef
} from "#x86/ir/model/types.js";

export type IrBlockInstruction = Readonly<{
  semantics: SemanticTemplate;
  operands: readonly OperandRef[];
  operandInfo?: readonly (SemanticOperandInfo | undefined)[];
  memoryGuards?: boolean;
}>;

export type IrBlockAppendResult = Readonly<{
  terminator: IrBlockTerminator;
}>;

export class IrBlockBuilder {
  readonly #ops: IrOp[] = [];
  #nextVarId = 0;

  appendInstruction(instruction: IrBlockInstruction): IrBlockAppendResult {
    const emitter = new IrEmitter({
      ops: this.#ops,
      allocateVar: () => this.#allocVar(),
      resolveOperand: (index) => blockOperand(instruction.operands, index),
      ...(instruction.operandInfo !== undefined
        ? { operandInfo: instruction.operandInfo }
        : {}),
      ...(instruction.memoryGuards !== undefined
        ? { memoryGuards: instruction.memoryGuards }
        : {})
    });

    instruction.semantics(emitter, emitter);
    return { terminator: emitter.finish() };
  }

  build(): IrBlock {
    return [...this.#ops];
  }

  #allocVar(): VarRef {
    const id = this.#nextVarId;

    this.#nextVarId += 1;
    return irVar(id);
  }
}

function blockOperand(operands: readonly OperandRef[], index: number): OperandRef {
  const operandRef = operands[index];

  if (operandRef === undefined) {
    throw new Error(`IR block operand ${index} is not provided`);
  }

  return operandRef;
}
