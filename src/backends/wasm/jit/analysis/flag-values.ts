import {
  flagProducerInputsFromRecord
} from "#ir/model/flags.js";
import type { IrFlagSetOp } from "#ir/model/types.js";
import { jitFlagProducerValue } from "#backends/wasm/jit/ir/values/builders.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";

export function jitFlagSetWrittenMask(op: Pick<IrFlagSetOp, "writtenMask" | "undefMask">): number {
  return (op.writtenMask | op.undefMask) >>> 0;
}

export function jitFlagSetProducerValue(
  op: IrFlagSetOp,
  inputs: Readonly<Record<string, JitValue>>
): JitValue {
  return simplifyValue(jitFlagProducerValue(
    op.producer,
    flagProducerInputsFromRecord(op.producer, inputs),
    {
      ...(op.width === undefined ? {} : { width: op.width }),
      mask: jitFlagSetWrittenMask(op)
    }
  ));
}
