import {
  flagProducerInputsFromRecord
} from "#x86/ir/model/flags.js";
import type { IrFlagSetOp } from "#x86/ir/model/types.js";
import { jitFlagProducerValue } from "#backends/wasm/jit/ir/value-builders.js";
import type { JitValue } from "#backends/wasm/jit/ir/value-types.js";

export function jitFlagSetWrittenMask(op: Pick<IrFlagSetOp, "writtenMask" | "undefMask">): number {
  return (op.writtenMask | op.undefMask) >>> 0;
}

export function jitFlagSetProducerValue(
  op: IrFlagSetOp,
  inputs: Readonly<Record<string, JitValue>>
): JitValue {
  return jitFlagProducerValue(
    op.producer,
    flagProducerInputsFromRecord(op.producer, inputs),
    {
      ...(op.width === undefined ? {} : { width: op.width }),
      mask: jitFlagSetWrittenMask(op)
    }
  );
}
