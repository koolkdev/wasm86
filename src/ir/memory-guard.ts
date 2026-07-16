import { BodyBuilder, type BuildBody } from "./body-builder.js";
import { memoryCheck } from "#compiler/ir/operations/memory.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { MemoryAccessKind } from "#core/semantics/refs.js";
import {
  pageFault,
  pageFaultErrorCode,
  type PageFaultAccess
} from "#core/exceptions.js";

export type MemoryGuardAccess =
  | Readonly<{ kind: "data"; access: MemoryAccessKind }>
  | Readonly<{ kind: "instructionFetch" }>;

export function emitMemoryGuard(
  builder: BodyBuilder,
  address: ValueId,
  byteLength: number,
  access: MemoryGuardAccess,
  // Restores or flushes state so the fault path reports the instruction-start state.
  buildFaultBodyPrefix: BuildBody = () => {}
): void {
  const { values } = builder;
  const fault = builder.operation(memoryCheck.create({
    address,
    byteLength: values.const(byteLength)
  }));

  builder.if(
    fault,
    (faultBody) => {
      buildFaultBodyPrefix(faultBody);

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
}

function pageFaultAccess(access: MemoryGuardAccess): PageFaultAccess {
  switch (access.kind) {
    case "data":
      return access.access === "write" ? "dataWrite" : "dataRead";
    case "instructionFetch":
      return "instructionFetch";
  }
}
