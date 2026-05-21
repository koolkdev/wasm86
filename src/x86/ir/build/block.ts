import { IrEmitter, type IrBlockTerminator } from "./emitter.js";
import { createIrVarAllocator, type IrVarAllocator } from "./vars.js";
import type {
  OperandRef,
  SemanticOperandInfo,
  SemanticTemplate,
  IrOp,
  IrBlock
} from "#x86/ir/model/types.js";

export type IrBlockInstruction = Readonly<{
  semantics: SemanticTemplate;
  operands: readonly OperandRef[];
  operandInfo?: readonly (SemanticOperandInfo | undefined)[];
}>;

export type IrBlockAppendResult = Readonly<{
  terminator: IrBlockTerminator;
}>;

export type IrBlockBuilderOptions = Readonly<{
  allocator?: IrVarAllocator;
}>;

export class IrBlockBuilder {
  readonly #ops: IrOp[] = [];
  readonly #allocator: IrVarAllocator;

  constructor(options: IrBlockBuilderOptions = {}) {
    this.#allocator = options.allocator ?? createIrVarAllocator();
  }

  appendInstruction(instruction: IrBlockInstruction): IrBlockAppendResult {
    const emitter = new IrEmitter({
      ops: this.#ops,
      allocator: this.#allocator,
      resolveOperand: (index) => blockOperand(instruction.operands, index),
      ...(instruction.operandInfo !== undefined
        ? { operandInfo: instruction.operandInfo }
        : {})
    });

    instruction.semantics(emitter, emitter);
    return { terminator: emitter.finish() };
  }

  build(): IrBlock {
    return [...this.#ops];
  }
}

function blockOperand(operands: readonly OperandRef[], index: number): OperandRef {
  const operandRef = operands[index];

  if (operandRef === undefined) {
    throw new Error(`IR block operand ${index} is not provided`);
  }

  return operandRef;
}
