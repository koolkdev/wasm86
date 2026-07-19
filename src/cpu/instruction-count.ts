import { FieldRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";

export const instructionCountField = new FieldRef(
  "cpu.execution.instruction-count",
  "u32"
);

export const instructionCountLayout = layoutStructure("cpu.execution", [
  instructionCountField
]);
