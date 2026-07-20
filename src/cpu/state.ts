import { resourceRef } from "#compiler/ir/resource.js";
import { createLayout } from "#compiler/layout/layout.js";
import {
  StateAccess,
  type StateResource
} from "#core/state/access.js";
import { flagStateLayout } from "#core/flags/layout.js";
import {
  createStatusFlagResolvers,
  type StatusFlagResolverFamily
} from "#core/flags/lazy/resolvers.js";
import { coreStateLayout } from "#core/state/layout.js";
import { instructionCounterLayout } from "./instruction-count.js";

export const cpuState: StateResource = {
  resource: resourceRef("cpu.state"),
  layout: createLayout("execution-state", [
    coreStateLayout,
    flagStateLayout,
    instructionCounterLayout
  ])
};

export const cpuStateAccess = new StateAccess(cpuState);

export const cpuStatusFlagResolvers: StatusFlagResolverFamily =
  createStatusFlagResolvers(cpuStateAccess);
