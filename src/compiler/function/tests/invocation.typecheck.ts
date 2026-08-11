import { Invocation, type CallTarget } from "#compiler/function/invocation.js";
import { functionType } from "#compiler/function/type.js";
import type { Float, Integer } from "#compiler/function/values.js";
import { Float as FloatType, Integer as IntegerType } from "#compiler/function/values.js";

const signature = functionType([IntegerType[8], FloatType[32]], []);

export function invocationTypeContract(
  target: CallTarget<typeof signature>,
  byte: Integer<8>,
  word: Integer<16>,
  single: Float<32>
): void {
  const invocation: Invocation<typeof signature> = Invocation.create({
    target,
    arguments: [byte, single]
  });
  const first: Integer<8> = invocation.arguments[0];
  const second: Float<32> = invocation.arguments[1];

  // @ts-expect-error argument widths follow the target signature.
  Invocation.create({ target, arguments: [word, single] });
  // @ts-expect-error argument kinds follow the target signature.
  Invocation.create({ target, arguments: [byte, word] });
  // @ts-expect-error argument count follows the target signature.
  Invocation.create({ target, arguments: [byte] });
  // @ts-expect-error invocation arguments preserve the signature's tuple length.
  invocation.arguments[2];

  void [first, second];
}
