import type { ValueRef } from "#compiler/function/values/reference.js";
import type { Integer, I32Value, I64Value } from "#compiler/function/values.js";
import type { FunctionValues, ValueScope } from "../scope.js";

export function scopeApiTypeContract(
  target: ValueScope,
  value: ValueRef,
  value32: I32Value,
  wide: I64Value,
  byte: Integer<8>
): void {
  const constant: number | undefined = target.constValue(byte);
  const same32: boolean = target.sameValue(value32, value32);
  const differentLogicalWidths: boolean = target.sameValue(value32, byte);
  const differentWidths: boolean = target.sameValue(value32, wide);

  target.resolve(value);
  target.resolveAll([value32, wide]);

  // @ts-expect-error resolve records the value and returns nothing.
  const id: number = target.resolve(value32);

  void [constant, same32, differentLogicalWidths, differentWidths, id];
}

export function functionValuesApiTypeContract(values: FunctionValues, value: ValueRef): void {
  values.resolutionOf(value);
  values.recordOf(value);
  values.identityCount();
  values.declaredSlots();

  // @ts-expect-error built functions do not expose build-time resolution.
  values.resolve(value);

  // @ts-expect-error built functions do not expose child value scopes.
  values.childScope();
}
