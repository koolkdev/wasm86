import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { AnyResourceAccess, ResourceAccess } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { Integer, I32Value } from "#compiler/function/values.js";
import type { ValueWidthForStorage } from "#compiler/function/resource.js";

type StateWritebackFor<TValueWidth extends ValueWidthForStorage<32>> = Readonly<{
  effect: ResourceEffect;
  value: Integer<TValueWidth>;
  emit(region: RegionBuilder): void;
}>;

type StateStorageWidth = Exclude<ValueWidthForStorage<32>, 1>;

export type StateWriteback = {
  readonly [TValueWidth in ValueWidthForStorage<32>]: StateWritebackFor<TValueWidth>;
}[ValueWidthForStorage<32>];

export function stateWriteback<
  Width extends StateStorageWidth,
  TValueWidth extends ValueWidthForStorage<Width> & ValueWidthForStorage<32>
>(
  destination: ResourceAccess<Width, TValueWidth>,
  value: Integer<NoInfer<TValueWidth>>
): StateWritebackFor<TValueWidth> {
  return {
    effect: destination.effect,
    value,
    emit(region) {
      region.writeResource(destination, value);
    }
  };
}

export function canonicalStateWriteback(
  destination: AnyResourceAccess<StateStorageWidth>,
  value: I32Value
): StateWriteback {
  const { effect, address } = destination;

  switch (destination.valueWidth) {
    case 1:
      return stateWriteback(
        { effect, address, storageWidth: destination.storageWidth, valueWidth: 1 },
        value.truncate(1)
      );
    case 8:
      return stateWriteback(
        { effect, address, storageWidth: destination.storageWidth, valueWidth: 8 },
        value.truncate(8)
      );
    case 16:
      return stateWriteback(
        { effect, address, storageWidth: destination.storageWidth, valueWidth: 16 },
        value.truncate(16)
      );
    case 32:
      return stateWriteback(
        { effect, address, storageWidth: destination.storageWidth, valueWidth: 32 },
        value
      );
  }
}
