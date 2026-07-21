import { createInstructionConstruction } from "#core/instruction/builder.js";
import { createStatusFlagResolvers } from "#core/flags/lazy/resolvers.js";
import { buildExit, exitLayout } from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { createExecutionModel } from "#execution/model.js";

export const testExecutionModel = createExecutionModel();

export const cpuState = testExecutionModel.cpuState;
export const cpuStateAccess = testExecutionModel.cpuState.access;
export const cpuStatusFlagResolvers =
  createStatusFlagResolvers(cpuStateAccess);
export const guestMemoryAccess = testExecutionModel.guestMemory.access;
export const guestMemoryResource = testExecutionModel.guestMemory.resource;
export { buildExit, exitLayout };

export const testInstructionConstruction = createInstructionConstruction({
  stateAccess: cpuStateAccess,
  memory: guestMemoryAccess,
  instructionCountField,
  buildExit
});
