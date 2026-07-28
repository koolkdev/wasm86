import type { VariantValue } from "#compiler/layout/variant-codec.js";
import type { CpuException } from "#core/exceptions.js";
import { VariantFieldRef, VariantRef, variantSet } from "#compiler/layout/variant.js";

export const coreExitFields = {
  gpCode: new VariantFieldRef("core.exit.general-protection.error-code", "u16"),
  pfAddress: new VariantFieldRef("core.exit.page-fault.linear-address", "u32"),
  pfCode: new VariantFieldRef("core.exit.page-fault.error-code", "u16"),
  trapVector: new VariantFieldRef("core.exit.host-trap.vector", "u8"),
  segment: new VariantFieldRef("core.exit.segment-load.segment", "u8"),
  selector: new VariantFieldRef("core.exit.segment-load.selector", "u16")
} as const;

export const coreExits = {
  de: new VariantRef("core.exit.divide-error", []),
  ud: new VariantRef("core.exit.undefined-instruction", []),
  gp: new VariantRef("core.exit.general-protection", [coreExitFields.gpCode]),
  pf: new VariantRef("core.exit.page-fault", [coreExitFields.pfAddress, coreExitFields.pfCode]),
  trap: new VariantRef("core.exit.host-trap", [coreExitFields.trapVector]),
  segment: new VariantRef("core.exit.segment-load", [
    coreExitFields.segment,
    coreExitFields.selector
  ])
} as const;

export const coreExitSet = variantSet("core.exit", [
  coreExits.de,
  coreExits.ud,
  coreExits.gp,
  coreExits.pf,
  coreExits.trap,
  coreExits.segment
]);

export function trapExit<TValue>(vector: TValue): VariantValue<TValue> {
  return {
    variant: coreExits.trap,
    payload: [{ field: coreExitFields.trapVector, value: vector }]
  };
}

export function segmentExit<TValue>(segment: TValue, selector: TValue): VariantValue<TValue> {
  return {
    variant: coreExits.segment,
    payload: [
      { field: coreExitFields.segment, value: segment },
      { field: coreExitFields.selector, value: selector }
    ]
  };
}

export function exceptionExit<TValue>(exception: CpuException<TValue>): VariantValue<TValue> {
  switch (exception.kind) {
    case "DE":
      return { variant: coreExits.de, payload: [] };
    case "UD":
      return { variant: coreExits.ud, payload: [] };
    case "GP":
      return {
        variant: coreExits.gp,
        payload: [
          {
            field: coreExitFields.gpCode,
            value: exception.errorCode
          }
        ]
      };
    case "PF":
      return {
        variant: coreExits.pf,
        payload: [
          {
            field: coreExitFields.pfAddress,
            value: exception.linearAddress
          },
          {
            field: coreExitFields.pfCode,
            value: exception.errorCode
          }
        ]
      };
  }
}
