import type { ResourceRef } from "#compiler/ir/resource.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import type { StatusFlagResolverFamily } from "#core/flags/lazy/resolvers.js";
import type { BuildExit } from "#core/instruction/terminal.js";
import type { StateAccess, StateResource } from "#core/state/access.js";
import type { MemoryAccessConstruction } from "#memory/access.js";

export type InterpreterMemory = Readonly<{
  resource: ResourceRef;
  access: MemoryAccessConstruction;
}>;

type InterpreterExecutionDependencies = Readonly<{
  statusFlagResolvers: StatusFlagResolverFamily;
  instructionCount: FieldRef<"u32">;
  instructionLimit: FieldRef<"u32">;
  buildExit: BuildExit;
}>;

export type InterpreterEnvironment =
  InterpreterExecutionDependencies & Readonly<{
    state: StateResource;
    memory: InterpreterMemory;
  }>;

export type InterpreterExecutionContext =
  InterpreterExecutionDependencies & Readonly<{
    stateAccess: StateAccess;
    memory: MemoryAccessConstruction;
  }>;
