import { IrEmitter, irBlockTerminator, type IrEmitterOptions } from "./emitter.js";
import type { SemanticTemplate, IrBlock } from "#x86/ir/model/types.js";

export {
  const32,
  mem,
  nextEip,
  operand,
  reg,
  irVar
} from "#x86/ir/model/refs.js";
export { irBlockTerminator };
export type { IrBlockTerminator } from "./emitter.js";

export type BuildIrOptions = Pick<IrEmitterOptions, "operandInfo" | "memoryGuards">;

export function buildIr(template: SemanticTemplate, options: BuildIrOptions = {}): IrBlock {
  const builder = new IrEmitter(options);

  template(builder, builder);
  return builder.block();
}
