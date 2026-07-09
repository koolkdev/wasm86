import type { Action } from "./actions.js";
import { BodyBuilder } from "./body-builder.js";
import type { MemoryAccessKind } from "./ops.js";
import type { ValueId } from "./values.js";
import type { ValueTable } from "./value-table.js";
import {
  pageFault,
  pageFaultErrorCode,
  type PageFaultAccess
} from "#x86/exceptions.js";

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
  const fault = builder.opValue({
    kind: "memory.check",
    address,
    byteLength: values.const(byteLength),
    access: memoryCheckAccess(access)
  });

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

function memoryCheckAccess(access: MemoryGuardAccess): MemoryAccessKind {
  switch (access.kind) {
    case "data":
      return access.access;
    case "instructionFetch":
      return "read";
  }
}

function pageFaultAccess(access: MemoryGuardAccess): PageFaultAccess {
  switch (access.kind) {
    case "data":
      return access.access === "write" ? "dataWrite" : "dataRead";
    case "instructionFetch":
      return "instructionFetch";
  }
}
