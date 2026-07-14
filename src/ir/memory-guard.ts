import type { Action } from "./actions.js";
import { BodyBuilder } from "./body-builder.js";
import { memoryCheck } from "#compiler/ir/operations/memory.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { MemoryAccessKind } from "#core/semantics/refs.js";
import {
  pageFault,
  pageFaultErrorCode,
  type PageFaultAccess
} from "#core/exceptions.js";

export type MemoryGuardAccess =
  | Readonly<{ kind: "data"; access: MemoryAccessKind }>
  | Readonly<{ kind: "instructionFetch" }>;

export function memoryGuardActions(
  values: ValueTable,
  address: ValueId,
  byteLength: number,
  access: MemoryGuardAccess,
  // Restores or flushes state so the fault path reports the instruction-start state.
  faultBodyPrefix: readonly Action[] = []
): readonly Action[] {
  const builder = new BodyBuilder(values);
  const fault = builder.operation(memoryCheck.create({
    address,
    byteLength: values.const(byteLength)
  }));

  builder.if(
    fault,
    (faultBody) => {
      for (const action of faultBodyPrefix) {
        faultBody.push(action);
      }

      faultBody.finish({
        kind: "exit",
        exit: {
          class: "cpuException",
          exception: pageFault(address, pageFaultErrorCode(pageFaultAccess(access)))
        }
      });
    },
    { hint: "unlikely" }
  );
  return builder.build().actions;
}

function pageFaultAccess(access: MemoryGuardAccess): PageFaultAccess {
  switch (access.kind) {
    case "data":
      return access.access === "write" ? "dataWrite" : "dataRead";
    case "instructionFetch":
      return "instructionFetch";
  }
}
