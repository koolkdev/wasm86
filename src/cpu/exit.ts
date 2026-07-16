import { assert } from "#common/assert.js";
import { buildVariant } from "#compiler/ir/values/variant.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { decodeVariant } from "#compiler/layout/variant-codec.js";
import { createVariantLayout } from "#compiler/layout/variant.js";
import {
  deExit,
  coreExits,
  coreExitFields,
  coreExitSet,
  pfExit,
  segmentExit,
  trapExit,
  udExit
} from "#core/exits.js";
import {
  divideError,
  invalidOpcode,
  pageFault,
  type CpuException
} from "#core/exceptions.js";
import { segmentRegisters } from "#core/types.js";
import {
  interpreterExits,
  interpreterExitSet
} from "#engines/interpreter/exits.js";
import type { RunStop } from "./cpu.js";

// Cpu resolves every configured owner's true exits once. Guest transfers use
// dispatch (or the temporary JIT transfer codec) and never enter this layout.
export const exitLayout = createVariantLayout("cpu.exit", [
  coreExitSet,
  interpreterExitSet
]);

// Block-shaped roots encode the selected owner variant as the scalar value
// consumed by Finish.
export function buildException(
  values: ValueTable,
  exception: CpuException<ValueId>
): ValueId {
  switch (exception.kind) {
    case "DE":
      return buildVariant(values, exitLayout, deExit());
    case "UD":
      return buildVariant(values, exitLayout, udExit());
    case "PF":
      return buildVariant(
        values,
        exitLayout,
        pfExit(exception.linearAddress, values.const(exception.errorCode))
      );
  }
}

export function buildTrap(values: ValueTable, vector: ValueId): ValueId {
  return buildVariant(values, exitLayout, trapExit(vector));
}

export function buildSegmentLoad(
  values: ValueTable,
  segment: ValueId,
  selector: ValueId
): ValueId {
  return buildVariant(values, exitLayout, segmentExit(segment, selector));
}

export function decodeExit(encoded: bigint): RunStop {
  const result = decodeVariant(exitLayout, encoded);

  if (result.variant === interpreterExits.budget) {
    return { kind: "instructionLimit" };
  }
  if (result.variant === interpreterExits.miss) {
    return { kind: "unsupported", reason: "unsupportedOpcode" };
  }
  if (result.variant === coreExits.trap) {
    return {
      kind: "hostTrap",
      vector: result.value(coreExitFields.trapVector)
    };
  }
  if (result.variant === coreExits.segment) {
    const segmentIndex = result.value(coreExitFields.segment);
    const segment = segmentRegisters[segmentIndex];

    assert(
      segment !== undefined,
      `segment-load exit has invalid segment index: ${segmentIndex}`
    );
    return {
      kind: "segmentLoad",
      segment,
      selector: result.value(coreExitFields.selector)
    };
  }
  if (result.variant === coreExits.de) {
    return { kind: "cpuException", exception: divideError() };
  }
  if (result.variant === coreExits.ud) {
    return { kind: "cpuException", exception: invalidOpcode() };
  }
  if (result.variant === coreExits.pf) {
    return {
      kind: "cpuException",
      exception: pageFault(
        result.value(coreExitFields.pfAddress),
        result.value(coreExitFields.pfCode)
      )
    };
  }

  assert(false, `unclassified Cpu exit variant: ${result.variant.id}`);
}
