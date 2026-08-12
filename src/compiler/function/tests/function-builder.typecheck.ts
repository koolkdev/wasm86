import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import { buildFunction } from "#compiler/function/builder/function.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import { functionType, type FunctionType } from "#compiler/function/type.js";
import {
  Float,
  Integer,
  i32,
  i64,
  type Float as FloatValue,
  type Integer as IntegerValue
} from "#compiler/function/values.js";

const callerType = functionType([Integer[32], Float[64]], [Integer[64]]);
const differentResultType = functionType([Integer[32]], [Integer[32]]);

export function functionBuilderTypeContract(
  fn: FunctionBuilder<typeof callerType>,
  target: CallTarget<typeof callerType>,
  differentResult: CallTarget<typeof differentResultType>
): void {
  const [integer, float] = fn.parameters;
  const exactInteger: IntegerValue<32> = integer;
  const exactFloat: FloatValue<64> = float;
  const [result] = fn.region.call(target, [integer, float]);
  const exactResult: IntegerValue<64> = result;

  fn.return([result]);
  fn.returnCall(target, [integer, float]);

  // @ts-expect-error the function has two parameters.
  fn.parameters[2];
  // @ts-expect-error the target expects an i32 and an f64.
  fn.region.call(target, [i64(0n), float]);
  // @ts-expect-error the function returns i64.
  fn.return([i32(0)]);
  // @ts-expect-error a tail call must return the enclosing function's result.
  fn.returnCall(differentResult, [integer]);
  // @ts-expect-error erasing a builder would widen its return contract.
  const erasedBuilder: FunctionBuilder<FunctionType> = fn;

  void [exactInteger, exactFloat, exactResult, erasedBuilder];
}

export function builtFunctionTypeContract(): void {
  const body = buildFunction(callerType, (fn) => {
    const [integer] = fn.parameters;

    fn.return([integer.unsigned.extend(64)]);
  });
  const exactType: typeof callerType = body.type;
  const exactInteger: IntegerValue<32> = body.parameters[0];
  const exactFloat: FloatValue<64> = body.parameters[1];

  void [exactType, exactInteger, exactFloat];
}
