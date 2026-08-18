import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { ResourceRef } from "#compiler/reference.js";
import type { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/function/type.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/reference.js";
import type { ExecutionModel } from "#execution/model.js";
import { createInstructionLowerer } from "#instructions/lowering/lowerer.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import { coreStateFields } from "#core/state/layout.js";
import { buildExit } from "#cpu/exit.js";
import { instructionCountField, instructionLimitField } from "#cpu/instruction-count.js";
import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import { Integer, i32, unreachable } from "#compiler/function/values.js";
import { buildDecodeAndDispatch, type BuildDecodedInstruction } from "./decode.js";
import { instructionLimitExit } from "./exits.js";
import { buildInterpreterInstruction, type BuildInterpreterContinuation } from "./instruction.js";

const interpreterRunType = functionType([], [Integer[64]]);
const instructionLengthLimit = X86_32_DECODE_MODEL.instructionLengthLimit;

export function defineInterpreterRun(
  program: ProgramBuilder,
  model: ExecutionModel
): FunctionDefinition<typeof interpreterRunType> {
  const stateAccess = model.cpuState.access;
  const memory = model.memory.access;
  const instructionLowerer = createInstructionLowerer({
    stateAccess,
    memory,
    instructionCountField,
    buildExit
  });
  const effects = interpreterRunEffects(model.cpuState.resource, model.memory.effects);

  // `run` is the common loop: it validates one maximum-length fetch window,
  // decodes directly from it, and continues with the next EIP. If that window
  // is unavailable, or the prefixes no longer leave room for the longest
  // possible suffix, it tail-calls `exactInstruction`.
  // The exact path checks only the bytes consumed by one instruction, then
  // tail-calls `run` to return to the common path. Function bodies are built
  // after both definitions exist, so the two paths can refer to each other.
  let exactInstruction: FunctionDefinition<typeof interpreterRunType> | undefined;
  const run = program.defineFunction(
    {
      ref: functionRef("interpreter.run"),
      type: interpreterRunType,
      effects
    },
    buildRunBody
  );

  exactInstruction = program.defineFunction(
    {
      ref: functionRef("interpreter.run.exact-instruction"),
      type: interpreterRunType,
      effects
    },
    buildExactInstructionBody
  );
  return run;

  function buildRunBody(fn: FunctionBuilder<typeof interpreterRunType>): void {
    assert(exactInstruction !== undefined, "exact interpreter instruction function is missing");
    const exact = exactInstruction;
    // This cache survives loop iterations but resets on the next invocation.
    const fetchMemory = memory.withCache(fn.region);
    const entryEip = stateAccess.forRegion(fn.region).readField(coreStateFields.eip);

    fn.region.loop([entryEip], (body, inputs) => {
      const instructionStart = inputs[0];

      buildInstructionLimitExit(body);
      // One range proof makes every direct byte read in this decode safe.
      const directFetch = fetchMemory.forRegion(body).resolveDirect(
        {
          start: instructionStart,
          byteLength: i32(instructionLengthLimit)
        },
        "instructionFetch"
      );
      const fallbackToExactInstruction = (region: RegionBuilder): void =>
        region.returnCall(exact, []);

      // The fallback re-decodes the same EIP; no architectural state has
      // changed while proving the window or consuming decode bytes.
      body.if(directFetch.unavailable, fallbackToExactInstruction, { hint: "unlikely" });
      const continueLoop: BuildInterpreterContinuation = (region, targetEip) =>
        region.loopContinue([targetEip]);

      buildDecodeAndDispatch(body, instructionStart, {
        stateAccess,
        memory: fetchMemory,
        buildExit,
        mode: {
          kind: "direct",
          access: directFetch.access,
          fallbackToExact: fallbackToExactInstruction
        },
        buildInstruction: buildInstructionWithContinuation(continueLoop)
      });
    });

    // Every live path continues, falls back to an exact instruction, or exits.
    fn.return([unreachable(64)]);
  }

  function buildExactInstructionBody(fn: FunctionBuilder<typeof interpreterRunType>): void {
    // Exact mode resolves only the bytes this instruction actually consumes.
    const fetchMemory = memory.withCache(fn.region);
    const instructionStart = stateAccess.forRegion(fn.region).readField(coreStateFields.eip);
    const resumeRun: BuildInterpreterContinuation = (region) => region.returnCall(run, []);

    buildInstructionLimitExit(fn.region);
    buildDecodeAndDispatch(fn.region, instructionStart, {
      stateAccess,
      memory: fetchMemory,
      buildExit,
      mode: { kind: "exact" },
      buildInstruction: buildInstructionWithContinuation(resumeRun)
    });
  }

  function buildInstructionWithContinuation(
    continuation: BuildInterpreterContinuation
  ): BuildDecodedInstruction {
    return (region, decoded) =>
      buildInterpreterInstruction(region, decoded, stateAccess, instructionLowerer, continuation);
  }

  function buildInstructionLimitExit(region: RegionBuilder): void {
    const state = stateAccess.forRegion(region);
    const count = state.readField(instructionCountField);
    const limit = state.readField(instructionLimitField);
    const countMinusLimit = count.sub(limit);
    const reached = countMinusLimit.signed.ge(0);

    region.if(
      reached,
      (expired) => {
        expired.return([buildExit(instructionLimitExit())]);
      },
      { hint: "unlikely" }
    );
  }
}

function interpreterRunEffects(state: ResourceRef, memory: StorageEffects): StorageEffects {
  const stateEffect = wholeResourceEffect(state);

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
