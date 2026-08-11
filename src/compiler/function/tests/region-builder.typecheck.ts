import {
  RegionBuilder,
  type SwitchArm,
  type SwitchControlArm
} from "#compiler/function/builder/region.js";
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

export function regionBuilderBranchTypeContract(
  values: ValueResolver,
  bit: Integer<1>,
  byte: Integer<8>,
  word: Integer<16>,
  dword: Integer<32>,
  qword: Integer<64>,
  single: Float<32>,
  double: Float<64>
): void {
  const builder = new RegionBuilder<readonly [(typeof FloatType)[32]]>(values);
  const floatArm: SwitchArm<Float<64>, readonly [(typeof FloatType)[32]]> = {
    match: 1,
    build: () => double
  };
  const defaultArm: SwitchArm = { match: 2, build: () => dword };
  const controlArm: SwitchControlArm<readonly [(typeof FloatType)[32]]> = {
    matches: [1, 2],
    build: (body) => body.return([single])
  };
  const joinedFloat: Float<32> = builder.ifValue(
    bit,
    () => single,
    () => single
  );
  const joinedByte: Integer<8> = builder.ifValue(
    bit,
    () => byte,
    () => byte
  );
  const switchedFloat: Float<64> = builder.switch(byte, [floatArm], () => double);
  const switchedDword: Integer<32> = builder.switch(dword, [defaultArm], () => dword);

  builder.if(bit, (body) => body.return([single]), {
    elseBuild: (body) => body.return([single])
  });
  builder.switch(bit, [], () => single);
  builder.switch(word, [], () => single);
  builder.switch(dword, [], () => single);
  builder.switchControl(byte, [controlArm], (body) => body.return([single]));

  // @ts-expect-error if conditions are one-bit integers.
  builder.if(byte, () => {});
  builder.ifValue(
    bit,
    () => single,
    // @ts-expect-error if value arms preserve their value kind and width.
    () => double
  );
  builder.switch(
    byte,
    [
      {
        match: 1,
        // @ts-expect-error switch arms preserve the default value's kind and width.
        build: () => byte
      }
    ],
    () => single
  );
  // @ts-expect-error 64-bit integers are not switch selectors.
  builder.switch(qword, [], () => single);
  // @ts-expect-error floats are not switch selectors.
  builder.switch(single, [], () => single);
  builder.if(bit, (body) => {
    // @ts-expect-error nested bodies preserve the enclosing function results.
    body.return([byte]);
  });

  void [joinedFloat, joinedByte, switchedFloat, switchedDword];
}
