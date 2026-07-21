import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceEffect, ResourceRef } from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/program/refs.js";
import { StateAccess } from "#core/state/access.js";
import { coreStateFields } from "#core/state/layout.js";
import type { FunctionBuilder } from "#ir/function.js";
import type { RegionBuilder } from "#ir/region-builder.js";
import { buildDecodeAndDispatch } from "./decode.js";
import type {
  InterpreterEnvironment,
  InterpreterExecutionContext
} from "./environment.js";
import { instructionLimitExit } from "./exits.js";
import { buildInterpreterInstruction } from "./instruction.js";

const interpreterRunType = functionType([], ["i64"]);

export function defineInterpreterRun(
  program: ProgramBuilder,
  environment: InterpreterEnvironment
): FunctionDefinition {
  const stateAccess = new StateAccess(environment.state);
  const execution: InterpreterExecutionContext = {
    stateAccess,
    statusFlagResolvers: environment.statusFlagResolvers,
    memory: environment.memory.access,
    instructionCount: environment.instructionCount,
    instructionLimit: environment.instructionLimit,
    buildExit: environment.buildExit
  };
  return program.defineFunction({
    ref: functionRef("interpreter.run"),
    type: interpreterRunType,
    effects: interpreterRunEffects(
      environment.state.resource,
      environment.memory.resource
    )
  }, (fn) => buildRunBody(fn, execution));
}

function buildRunBody(
  fn: FunctionBuilder,
  context: InterpreterExecutionContext
): void {
  const entryEip = context.stateAccess.bind(fn.region).readField(
    coreStateFields.eip
  );
  const instructionStart = fn.values.addLoopInput();

  fn.region.loop([{ seed: entryEip, loopInput: instructionStart }], (body) => {
    body.if(instructionLimitReached(body, context), (expired) => {
      expired.return([
        context.buildExit(expired.values, instructionLimitExit())
      ]);
    }, { hint: "unlikely" });
    buildDecodeAndDispatch(body, instructionStart, {
      stateAccess: context.stateAccess,
      memory: context.memory,
      buildExit: context.buildExit,
      buildInstruction: (region, decoded) =>
        buildInterpreterInstruction(region, decoded, context)
    });
  });

  // Every live path either continues the interpreter loop or returns an exit.
  fn.return([fn.values.unreachable("i64")]);
}

function instructionLimitReached(
  region: RegionBuilder,
  context: InterpreterExecutionContext
): ValueId {
  const state = context.stateAccess.bind(region);
  const count = state.readField(context.instructionCount);
  const limit = state.readField(context.instructionLimit);
  const countMinusLimit = region.values.binary("sub", count, limit);

  return region.values.compare(
    32,
    "ge_s",
    countMinusLimit,
    region.values.const(0)
  );
}

function interpreterRunEffects(
  state: ResourceRef,
  memory: ResourceRef
): StorageEffects {
  const resources = [
    wholeResourceEffect(state),
    wholeResourceEffect(memory)
  ];

  return {
    reads: resources,
    writes: resources
  };
}

function wholeResourceEffect(resource: ResourceRef): ResourceEffect {
  return {
    space: "resource",
    resource,
    range: { basis: { kind: "resource" } }
  };
}
