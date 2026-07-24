import { assert } from "#common/assert.js";
import {
  createLayoutHostView,
  type LayoutHostView
} from "#compiler/layout/host-view.js";
import {
  pageFault,
  pageFaultErrorCode
} from "#core/exceptions.js";
import type { MachineMemoryDefinition } from "../machine-memory.js";
import type {
  BoundPhysicalAddressSpace,
  PhysicalAddressSpaceDefinition
} from "../physical.js";
import type {
  GuestMemoryByteRead,
  GuestMemoryReader,
  MemoryReadIntent
} from "../types.js";
import {
  pageTableEntries,
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  pageTableEntryLayout,
  virtualPageByteLength,
  virtualPageOffsetMask
} from "./layout.js";

export type BoundVirtualAddressSpace = Readonly<{
  initializeIdentity(): void;
  reader: GuestMemoryReader;
}>;

export function bindVirtualAddressSpace(
  physical: PhysicalAddressSpaceDefinition,
  machineMemoryDefinition: MachineMemoryDefinition,
  bindings: Readonly<{
    ram: WebAssembly.Memory;
    machine: WebAssembly.Memory;
  }>
): BoundVirtualAddressSpace {
  const boundPhysical = physical.bindHost({ ram: bindings.ram });
  const machineView = createLayoutHostView(
    bindings.machine,
    machineMemoryDefinition.layout
  );

  return {
    initializeIdentity: () => initializeIdentity(
      bindings.ram,
      bindings.machine,
      machineMemoryDefinition
    ),
    reader: {
      readByte: (address, intent) => readVirtualByte(
        boundPhysical,
        machineView,
        address,
        intent
      )
    }
  };
}

function initializeIdentity(
  ram: WebAssembly.Memory,
  machine: WebAssembly.Memory,
  machineMemoryDefinition: MachineMemoryDefinition
): void {
  const entries = machineMemoryDefinition.layout.array(
    pageTableEntries
  );
  const mappedPageCount =
    ram.buffer.byteLength / virtualPageByteLength;

  assert(
    mappedPageCount <= entries.count,
    "physical RAM exceeds the virtual page table"
  );
  // Clear only Virtual's PTE slice, then map every page in the current,
  // Wasm-rounded RAM backing. Machine calls this once; later RAM growth
  // deliberately adds physical backing without publishing new mappings.
  new Uint8Array(
    machine.buffer,
    entries.offset,
    entries.stride * entries.count
  ).fill(0);
  const view = new DataView(machine.buffer);
  const attributes =
    pageTableEntryAttr.PRESENT | pageTableEntryAttr.WRITABLE;

  for (let page = 0; page < mappedPageCount; page += 1) {
    view.setUint32(
      entries.offset + page * entries.stride,
      page * virtualPageByteLength + attributes,
      true
    );
  }
}

function readVirtualByte(
  physical: BoundPhysicalAddressSpace,
  machine: LayoutHostView,
  address: number,
  intent: MemoryReadIntent
): GuestMemoryByteRead {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff_ffff) {
    throw new RangeError(`virtual memory address must be u32, got ${address}`);
  }
  const page = Math.floor(address / virtualPageByteLength);
  const entry = machine.readArrayElement(
    pageTableEntries,
    page,
    0,
    pageTableEntryLayout.byteLength
  );

  if ((entry & pageTableEntryAttr.PRESENT) === 0) {
    return {
      kind: "exception",
      exception: pageFault(address, pageFaultErrorCode(intent))
    };
  }
  const frame = (entry & pageTableEntryFrameMask) >>> 0;
  const physicalAddress = frame + (address & virtualPageOffsetMask);
  const value = physical.reader.readByte(physicalAddress);

  // PRESENT is internal mapping authority. A missing Physical byte is an
  // emulator invariant failure, not an architectural page fault.
  assert(
    value !== undefined,
    `present virtual address ${address} maps absent physical address ${physicalAddress}`
  );
  return { kind: "value", value };
}
