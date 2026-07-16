import type { VariantValue } from "#compiler/layout/variant-codec.js";
import {
  VariantFieldRef,
  VariantRef,
  variantSet
} from "#compiler/layout/variant.js";

export const coreExitFields = {
  pfAddress: new VariantFieldRef(
    "core.exit.page-fault.linear-address",
    "u32"
  ),
  pfCode: new VariantFieldRef(
    "core.exit.page-fault.error-code",
    "u16"
  ),
  trapVector: new VariantFieldRef("core.exit.host-trap.vector", "u8"),
  segment: new VariantFieldRef(
    "core.exit.segment-load.segment",
    "u8"
  ),
  selector: new VariantFieldRef(
    "core.exit.segment-load.selector",
    "u16"
  )
} as const;

export const coreExits = {
  de: new VariantRef("core.exit.divide-error", []),
  ud: new VariantRef("core.exit.undefined-instruction", []),
  pf: new VariantRef("core.exit.page-fault", [
    coreExitFields.pfAddress,
    coreExitFields.pfCode
  ]),
  trap: new VariantRef("core.exit.host-trap", [
    coreExitFields.trapVector
  ]),
  segment: new VariantRef("core.exit.segment-load", [
    coreExitFields.segment,
    coreExitFields.selector
  ])
} as const;

export const coreExitSet = variantSet("core.exit", [
  coreExits.de,
  coreExits.ud,
  coreExits.pf,
  coreExits.trap,
  coreExits.segment
]);

export function deExit(): VariantValue<never> {
  return { variant: coreExits.de, payload: [] };
}

export function udExit(): VariantValue<never> {
  return { variant: coreExits.ud, payload: [] };
}

export function pfExit<TValue>(
  linearAddress: TValue,
  errorCode: TValue
): VariantValue<TValue> {
  return {
    variant: coreExits.pf,
    payload: [
      { field: coreExitFields.pfAddress, value: linearAddress },
      { field: coreExitFields.pfCode, value: errorCode }
    ]
  };
}

export function trapExit<TValue>(vector: TValue): VariantValue<TValue> {
  return {
    variant: coreExits.trap,
    payload: [{ field: coreExitFields.trapVector, value: vector }]
  };
}

export function segmentExit<TValue>(
  segment: TValue,
  selector: TValue
): VariantValue<TValue> {
  return {
    variant: coreExits.segment,
    payload: [
      { field: coreExitFields.segment, value: segment },
      { field: coreExitFields.selector, value: selector }
    ]
  };
}
