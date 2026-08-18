import type { Integer, I32Value } from "#compiler/function/values.js";
import type { PhysicalAccess, PhysicalAccessOperations } from "#memory/physical.js";
import type { BoundMemoryAccess, DirectMemoryAccess, ResolvedMemoryAccess } from "#memory/types.js";

export function memoryTransferWidthContract(
  memory: BoundMemoryAccess,
  resolvedRead: ResolvedMemoryAccess,
  resolvedWrite: ResolvedMemoryAccess<"write">,
  directRead: DirectMemoryAccess,
  directWrite: DirectMemoryAccess<"write">,
  offset: I32Value,
  qword: Integer<64>
): void {
  // @ts-expect-error virtual memory transfers are at most 32 bits.
  memory.load(resolvedRead, offset, 64);
  // @ts-expect-error direct virtual memory transfers are at most 32 bits.
  memory.loadDirect(directRead, offset, 64);
  // @ts-expect-error virtual memory transfers are at most 32 bits.
  memory.store(resolvedWrite, offset, qword);
  // @ts-expect-error direct virtual memory transfers are at most 32 bits.
  memory.storeDirect(directWrite, offset, qword);
}

export function physicalTransferWidthContract(
  physical: PhysicalAccessOperations,
  access: PhysicalAccess,
  offset: I32Value,
  qword: Integer<64>
): void {
  // @ts-expect-error physical RAM transfers are at most 32 bits.
  physical.load(access, offset, 64);
  // @ts-expect-error physical RAM transfers are at most 32 bits.
  physical.store(access, offset, qword);
}
