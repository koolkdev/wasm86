import { assert } from "#common/assert.js";
import { u32 } from "#common/numeric.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { ResourceRef } from "#compiler/reference.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import type { Program } from "#compiler/program/program.js";
import { functionType } from "#compiler/function/type.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { functionExportRef, type FunctionExportRef } from "#compiler/program/exports.js";
import { Integer, i32, type I64Value } from "#compiler/function/values.js";
import { functionRef } from "#compiler/reference.js";
import {
  createInstructionLowerer,
  type InstructionLowerer
} from "#instructions/lowering/lowerer.js";
import { staticInstructionLocation } from "#instructions/lowering/builder.js";
import { staticOperandBinding } from "#instructions/lowering/static-binding.js";
import type { InstructionTerminals } from "#instructions/lowering/terminal.js";
import { exceptionExit } from "#core/exits.js";
import { mapCpuException, type CpuException } from "#core/exceptions.js";
import type { StateAccess } from "#core/state/access.js";
import { coreStateFields } from "#core/state/layout.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import type { ExecutionModel } from "#execution/model.js";
import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import type { JitDecodedBlock } from "./decode-block.js";

const jitBlockType = functionType([], [Integer[64]]);
const jitDispatchType = functionType([Integer[32]], [Integer[64]]);
const jitDispatchImportName = "dispatch";

type JitProgram = Readonly<{
  program: Program;
  entry: FunctionExportRef;
}>;

export function buildJitProgram(model: ExecutionModel, decoded: JitDecodedBlock): JitProgram {
  const program = new ProgramBuilder(model.resources);
  const effects = jitExecutionEffects(model.cpuState.resource, model.memory.effects);
  const dispatch = program.importFunction({
    ref: functionRef("jit.dispatch"),
    type: jitDispatchType,
    effects,
    moduleName: programImportModuleName,
    name: jitDispatchImportName
  });
  const block = defineJitBlock(program, model, decoded, dispatch);
  const entry = functionExportRef(`jit.block-export.${hex(decoded.startEip)}`);

  program.exportFunction({
    ref: entry,
    name: `block_${hex(decoded.startEip)}`,
    target: block.ref
  });
  return { program: program.finish(), entry };
}

function defineJitBlock(
  program: ProgramBuilder,
  model: ExecutionModel,
  decoded: JitDecodedBlock,
  dispatch: CallTarget<typeof jitDispatchType>
): FunctionDefinition<typeof jitBlockType> {
  const instructionLowerer = createInstructionLowerer({
    stateAccess: model.cpuState.access,
    memory: model.memory.access,
    instructionCountField,
    buildExit
  });

  return program.defineFunction(
    {
      ref: functionRef(`jit.block.${hex(decoded.startEip)}`),
      type: jitBlockType,
      effects: jitExecutionEffects(model.cpuState.resource, model.memory.effects)
    },
    (fn) => buildJitBlockBody(fn, decoded, model.cpuState.access, instructionLowerer, dispatch)
  );
}

function buildJitBlockBody(
  fn: FunctionBuilder<typeof jitBlockType>,
  decoded: JitDecodedBlock,
  stateAccess: StateAccess,
  instructionLowerer: InstructionLowerer,
  dispatch: CallTarget<typeof jitDispatchType>
): void {
  if (decoded.instructions.length === 0) {
    assert(
      decoded.terminator.kind === "cpuException",
      "an empty decoded JIT block must end in a CPU exception"
    );
    const state = stateAccess.forRegion(fn.region);

    state.write(state.field(coreStateFields.eip), i32(decoded.terminator.instructionStart));
    fn.return([buildCpuExceptionExit(decoded.terminator.exception)]);
    return;
  }

  const finalFallthrough = instructionLowerer.lower(
    fn.region,
    jitInstructionTerminals(dispatch),
    (builder) => {
      for (const instruction of decoded.instructions) {
        const continues = builder.add(
          instruction.spec.semantics,
          instruction.operands.map(staticOperandBinding),
          staticInstructionLocation(instruction.address, instruction.nextEip)
        );

        if (!continues) {
          break;
        }
      }
    }
  );

  if (finalFallthrough === undefined) {
    return;
  }
  if (decoded.terminator.kind === "cpuException") {
    const completedEip = fn.region.constValue(finalFallthrough);

    assert(
      completedEip !== undefined && u32(completedEip) === u32(decoded.terminator.instructionStart),
      "a decode-time CPU exception does not follow the decoded instruction prefix"
    );
    fn.return([buildCpuExceptionExit(decoded.terminator.exception)]);
    return;
  }
  fn.returnCall(dispatch, [finalFallthrough]);
}

function jitInstructionTerminals(
  dispatch: CallTarget<typeof jitDispatchType>
): InstructionTerminals {
  return {
    dispatch: (region, targetEip) => {
      region.returnCall(dispatch, [targetEip]);
    },
    returnExit: (region, result) => {
      region.return([result]);
    }
  };
}

function buildCpuExceptionExit(exception: CpuException<number>): I64Value {
  return buildExit(exceptionExit(mapCpuException(exception, i32)));
}

function jitExecutionEffects(cpuState: ResourceRef, memory: StorageEffects): StorageEffects {
  const stateEffect = wholeResourceEffect(cpuState);

  return {
    reads: [stateEffect, ...memory.reads],
    writes: [stateEffect, ...memory.writes]
  };
}

function wholeResourceEffect(resource: ResourceRef): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "whole", origin: "resource" }
  };
}

function hex(value: number): string {
  return u32(value).toString(16);
}
