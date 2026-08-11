import { Invocation, type CallTarget } from "#compiler/function/invocation.js";
import { Operation } from "#compiler/function/operation.js";
import type { ResourceAccess } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { functionType } from "#compiler/function/type.js";
import type { Float, Integer } from "#compiler/function/values.js";
import { Float as FloatType } from "#compiler/function/values.js";

const resultlessType = functionType([], []);
const resultType = functionType([], [FloatType[32]]);

export function operationTypeContract(
  byteAccess: ResourceAccess<16, 8>,
  byte: Integer<8>,
  word: Integer<16>,
  single: Float<32>,
  double: Float<64>,
  variable: VariableRef<(typeof FloatType)[64]>,
  resultlessTarget: CallTarget<typeof resultlessType>,
  resultTarget: CallTarget<typeof resultType>
): void {
  const read = Operation.resourceRead(byteAccess, byte);
  const write = Operation.resourceWrite(byteAccess, byte);
  const variableReadOperation = Operation.variableRead(variable, double);
  const variableWriteOperation = Operation.variableWrite(variable, double, "update");
  const resultlessCall = Operation.call(
    Invocation.create({ target: resultlessTarget, arguments: [] })
  );
  const resultCall = Operation.call(
    Invocation.create({ target: resultTarget, arguments: [] }),
    single
  );

  // @ts-expect-error resource outputs use the access's logical value width.
  Operation.resourceRead(byteAccess, word);
  // @ts-expect-error resource writes use the access's logical value width.
  Operation.resourceWrite(byteAccess, word);
  // @ts-expect-error variable reads preserve the variable's value type.
  Operation.variableRead(variable, single);
  // @ts-expect-error variable writes preserve the variable's value type.
  Operation.variableWrite(variable, single, "update");
  // @ts-expect-error resultless calls do not accept an output.
  Operation.call(Invocation.create({ target: resultlessTarget, arguments: [] }), byte);
  // @ts-expect-error value-producing calls require an output.
  Operation.call(Invocation.create({ target: resultTarget, arguments: [] }));
  // @ts-expect-error call outputs follow the target's result type.
  Operation.call(Invocation.create({ target: resultTarget, arguments: [] }), byte);

  void [read, write, variableReadOperation, variableWriteOperation, resultlessCall, resultCall];
}
