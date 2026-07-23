import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ResourceEffect, ResourceRef } from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import type { ExecutionModel } from "#execution/model.js";
import {
  createInstructionConstruction,
  type InstructionConstruction
} from "#core/instruction/builder.js";
import { coreStateFields } from "#core/state/layout.js";
import type { StateAccess } from "#core/state/access.js";
import { buildExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { buildDecodeAndDispatch } from "./decode.js";
import { instructionLimitExit } from "./exits.js";
import { buildInterpreterInstruction } from "./instruction.js";

const interpreterRunType = functionType([], ["i64"]);

export function defineInterpreterRun(
  program: ProgramBuilder,
  model: ExecutionModel
): FunctionDefinition {
  const instructionConstruction = createInstructionConstruction({
    stateAccess: model.cpuState.access,
    memory: model.guestMemory.access,
    instructionCountField,
    buildExit
  });

  return program.defineFunction({
    ref: functionRef("interpreter.run"),
    type: interpreterRunType,
    effects: interpreterRunEffects(
      model.cpuState.resource,
      model.guestMemory.resource
    )
  }, (fn) => buildRunBody(fn, model, instructionConstruction));
}

function buildRunBody(
  fn: FunctionBuilder,
  model: ExecutionModel,
  instructionConstruction: InstructionConstruction
): void {
  const stateAccess = model.cpuState.access;
  const entryEip = stateAccess.bind(fn.region).readField(
    coreStateFields.eip
  );
  const instructionStart = fn.values.addLoopInput();

  fn.region.loop([{ seed: entryEip, loopInput: instructionStart }], (body) => {
    body.if(instructionLimitReached(body, stateAccess), (expired) => {
      expired.return([
        buildExit(expired.values, instructionLimitExit())
      ]);
    }, { hint: "unlikely" });
    buildDecodeAndDispatch(body, instructionStart, {
      stateAccess,
      memory: model.guestMemory.access,
      buildExit,
      buildInstruction: (region, decoded) =>
        buildInterpreterInstruction(
          region,
          decoded,
          stateAccess,
          instructionConstruction
        )
    });
  });

  // Every live path either continues the interpreter loop or returns an exit.
  fn.return([fn.values.unreachable("i64")]);
}

function instructionLimitReached(
  region: RegionBuilder,
  stateAccess: StateAccess
): ValueId {
  const state = stateAccess.bind(region);
  const count = state.readField(instructionCountField);
  const limit = state.readField(instructionLimitField);
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
