import { assert } from "#common/assert.js";
import { buildVariant } from "#compiler/ir/values/variant.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  decodeVariant,
  type VariantValue
} from "#compiler/layout/variant-codec.js";
import { createVariantLayout } from "#compiler/layout/variant.js";
import {
  coreExits,
  coreExitFields,
  coreExitSet
} from "#core/exits.js";
import {
  divideError,
  invalidOpcode,
  pageFault
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

export function buildExit(
  values: ValueTable,
  exit: VariantValue<ValueId>
): ValueId {
  return buildVariant(values, exitLayout, exit);
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
