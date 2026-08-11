import { RegionBuilder } from "#compiler/function/builder/region.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import type { Float, Integer } from "#compiler/function/values.js";
import { Float as FloatType, Integer as IntegerType } from "#compiler/function/values.js";
import type { ValueResolver } from "#compiler/function/values/resolver.js";

const valueTargetType = functionType([IntegerType[8]], [FloatType[32]]);
const resultlessTargetType = functionType([IntegerType[8]], []);
const wrongResultTargetType = functionType([IntegerType[8]], [IntegerType[8]]);
const multipleResultTargetType = functionType([IntegerType[8]], [FloatType[32], IntegerType[8]]);

export function regionBuilderTypeContract(
  values: ValueResolver,
  byteAccess: ResourceAccess<16, 8>,
  byte: Integer<8>,
  word: Integer<16>,
  single: Float<32>,
  valueTarget: CallTarget<typeof valueTargetType>,
  resultlessTarget: CallTarget<typeof resultlessTargetType>,
  wrongResultTarget: CallTarget<typeof wrongResultTargetType>,
  multipleResultTarget: CallTarget<typeof multipleResultTargetType>
): void {
  const builder = new RegionBuilder<(typeof valueTargetType)["results"]>(values);
  const variable = builder.variable(single);
  const exactVariable: VariableRef<(typeof FloatType)[32]> = variable;
  const integerVariable = builder.variable(byte);
  const exactIntegerVariable: VariableRef<(typeof IntegerType)[8]> = integerVariable;
  const variableValue: Float<32> = builder.read(variable);

  builder.write(variable, single);
  // @ts-expect-error variable writes preserve the seed's value type.
  builder.write(variable, byte);

  const resourceValue: Integer<8> = builder.readResource(byteAccess);

  builder.writeResource(byteAccess, byte);
  // @ts-expect-error resource writes preserve the access's logical value width.
  builder.writeResource(byteAccess, word);

  const [callResult] = builder.call(valueTarget, [byte]);
  const exactCallResult: Float<32> = callResult;
  const noResults = builder.call(resultlessTarget, [byte]);

  // @ts-expect-error call arguments follow the target signature.
  builder.call(valueTarget, [word]);
  // @ts-expect-error multi-result calls are not supported yet.
  builder.call(multipleResultTarget, [byte]);
  // @ts-expect-error a resultless call has an empty result tuple.
  noResults[0];

  builder.return([callResult]);
  // @ts-expect-error direct returns follow the enclosing function results.
  builder.return([byte]);
  builder.returnCall(valueTarget, [byte]);
  // @ts-expect-error returned calls follow the enclosing function results.
  builder.returnCall(wrongResultTarget, [byte]);

  void [exactVariable, exactIntegerVariable, variableValue, resourceValue, exactCallResult];
}
