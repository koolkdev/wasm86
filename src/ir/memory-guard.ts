import { assert } from "#common/assert.js";
import type { Action } from "./actions.js";
import { createOpAction } from "./actions.js";
import type { Body } from "./block.js";
import type { ValueId, ValueTable } from "./values.js";
import type { MemoryAccessKind } from "#x86/semantics/builder.js";
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
  const check = createOpAction(values, {
    kind: "memory.check",
    address,
    byteLength,
    access: memoryCheckAccess(access)
  });

  assert(check.output !== undefined, "memory.check guard action is missing its output");
  const fault = check.output;

  return [
    check,
    {
      kind: "if",
      condition: fault,
      hint: "unlikely",
      thenBody: pageFaultBody(address, pageFaultErrorCode(pageFaultAccess(access)), faultBodyPrefix)
    }
  ];
}

function pageFaultBody(
  linearAddress: ValueId,
  errorCode: number,
  prefix: readonly Action[]
): Body {
  return {
    actions: [
      ...prefix,
      {
        kind: "finish",
        finish: {
          kind: "exit",
          exit: {
            class: "cpuException",
            exception: pageFault(linearAddress, errorCode)
          }
        }
      }
    ]
  };
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
