import { bitField, FieldRef } from "../handles.js";

export function fieldRefTypeContract(): void {
  const flag: FieldRef<"u8", 1> = bitField("flag");

  // @ts-expect-error a field's logical value cannot be wider than its storage.
  const invalid = new FieldRef<"u8", 16>("invalid", "u8", 16);
  // @ts-expect-error a narrower logical value must be declared explicitly.
  const missingValueWidth = new FieldRef<"u8", 1>("missing-value-width", "u8");

  void [flag, invalid, missingValueWidth];
}
