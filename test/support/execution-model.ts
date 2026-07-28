import { createInstructionLowerer } from "#instructions/lowering/lowerer.js";
import { createStatusFlagResolvers } from "#core/flags/lazy/resolvers.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { createExecutionModel } from "#execution/model.js";

export const testExecutionModel = createExecutionModel();

export const cpuState = testExecutionModel.cpuState;
export const cpuStateAccess = testExecutionModel.cpuState.access;
export const cpuStatusFlagResolvers = createStatusFlagResolvers(cpuStateAccess);
export const guestMemoryAccess = testExecutionModel.memory.access;
export const guestMemoryResource = testExecutionModel.memory.physical.ramResource;
export const testInstructionLowerer = createInstructionLowerer({
  stateAccess: cpuStateAccess,
  memory: guestMemoryAccess,
  instructionCountField,
  buildExit
});
