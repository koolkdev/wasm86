import type { Float as FloatValue, Integer as IntegerValue } from "#compiler/function/values.js";
import { ValueResolver } from "../resolver.js";
import { Float, Integer } from "../type.js";

export function resolverTypeContract(): void {
  const values = new ValueResolver();
  const [byte, single] = values.parameters([Integer[8], Float[32]] as const);
  const wide = values.producer(Float[64]);
  const exactByte: IntegerValue<8> = byte;
  const exactSingle: FloatValue<32> = single;
  const exactWide: FloatValue<64> = wide;

  void [exactByte, exactSingle, exactWide];
}
