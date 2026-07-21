import {
  type InstructionConstruction,
  type InstructionBuilder,
  type InstructionLocation
} from "#core/instruction/builder.js";
import type { SemanticTemplate } from "#core/semantics/builder.js";
import { RegionBuilder } from "#ir/region-builder.js";
import type { IrBlock } from "#ir/block.js";
import type { OperandBinding } from "#core/instruction/bindings.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { InstructionTerminals } from "#core/instruction/terminal.js";

export type LegacyInstructionBlock = Readonly<{
  add(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): boolean;
  finish(): IrBlock;
}>;

// The JIT still embeds IrBlock/Finish. This bridge owns that temporary outer
// shape; all x86 construction stays in Core.
export function createLegacyInstructionBlock(
  construction: InstructionConstruction
): LegacyInstructionBlock {
  const values = new ValueTable();
  const region = new RegionBuilder(values);
  const builder = construction.createBuilder(
    region,
    new LegacyInstructionTerminals()
  );

  return {
    add: (template, bindings, location) => builder.add(template, bindings, location),
    finish: () => buildLegacyBlock(builder, region, values)
  };
}

class LegacyInstructionTerminals implements InstructionTerminals {
  dispatch(region: RegionBuilder, targetEip: ValueId): void {
    region.finish({ kind: "dispatch", targetEip });
  }

  returnExit(region: RegionBuilder, result: ValueId): void {
    region.finish({ kind: "exit", result });
  }
}

function buildLegacyBlock(
  builder: InstructionBuilder,
  region: RegionBuilder,
  values: ValueTable
): IrBlock {
  const finalFallthrough = builder.finish();

  if (finalFallthrough !== undefined) {
    region.finish({ kind: "dispatch", targetEip: finalFallthrough });
  }
  return { body: region.build(), values };
}
