import { assert } from "#common/assert.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import {
  DynamicByteOriginRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceRef
} from "#compiler/ir/resource.js";
import {
  pageFault,
  pageFaultErrorCode
} from "#core/exceptions.js";
import { readBackingByte } from "./bytes.js";
import { guestMemoryMinimumByteLength } from "./constants.js";
import type {
  GuestMemoryByteRead,
  GuestMemoryReader,
  LinearRange,
  MemoryAccess,
  MemoryAccessIntent,
  MemoryReadIntent,
  MemoryResolution
} from "./access.js";

type FlatMemoryValues = Pick<ValueBuilder, "const" | "binary" | "compare"> & ConstantValues;

type ConstantValues = Readonly<{
  constValue(value: ValueId): number | undefined;
}>;

const addressSpaceByteLength = 0x1_0000_0000;

export function createFlatGuestMemoryReader(
  memory: WebAssembly.Memory
): GuestMemoryReader {
  validateFlatMemoryBinding(memory);
  return {
    readByte: (address, intent) => readFlatMemoryByte(memory, address, intent)
  };
}

function readFlatMemoryByte(
  memory: WebAssembly.Memory,
  address: number,
  intent: MemoryReadIntent
): GuestMemoryByteRead {
  if (!Number.isInteger(address) || address < 0 || address > 0xffff_ffff) {
    throw new RangeError(`flat memory address must be u32, got ${address}`);
  }

  if (address >= guestMemoryMinimumByteLength) {
    return {
      kind: "exception",
      exception: pageFault(address, pageFaultErrorCode(intent))
    };
  }

  const value = readBackingByte(memory, address);

  assert(value !== undefined, `checked flat memory byte is absent at ${address}`);
  return { kind: "value", value };
}

function validateFlatMemoryBinding(memory: WebAssembly.Memory): void {
  if (memory.buffer.byteLength < guestMemoryMinimumByteLength) {
    throw new RangeError(
      "guest memory is shorter than the flat address-space binding"
    );
  }
}

export function flatMemoryResolution<TIntent extends MemoryAccessIntent>(
  values: FlatMemoryValues,
  range: LinearRange,
  intent: TIntent
): MemoryResolution<TIntent> {
  const staticByteLength = values.constValue(range.byteLength);

  if (staticByteLength !== undefined) {
    assert(
      Number.isInteger(staticByteLength) &&
        staticByteLength > 0 &&
        staticByteLength <= guestMemoryMinimumByteLength,
      `flat access byte length must be an integer between 1 and ${guestMemoryMinimumByteLength}, got ${staticByteLength}`
    );

    return createMemoryResolution(
      values,
      range,
      values.compare(
        32,
        "gt_u",
        range.start,
        values.const(guestMemoryMinimumByteLength - staticByteLength)
      ),
      intent
    );
  }

  const one = values.const(1);
  const last = values.const(guestMemoryMinimumByteLength - 1);
  const lengthMinusOne = values.binary("sub", range.byteLength, one);
  const faulted = values.binary(
    "or",
    values.compare(32, "gt_u", range.start, last),
    values.compare(
      32,
      "gt_u",
      lengthMinusOne,
      values.binary("sub", last, range.start)
    )
  );
  return createMemoryResolution(values, range, faulted, intent);
}

function createMemoryResolution<TIntent extends MemoryAccessIntent>(
  values: FlatMemoryValues,
  range: LinearRange,
  faulted: ValueId,
  intent: TIntent
): MemoryResolution<TIntent> {
  return {
    access: {
      range,
      origin: new DynamicByteOriginRef(),
      intent
    },
    fault: {
      condition: faulted,
      exception: pageFault(
        range.start,
        values.const(pageFaultErrorCode(intent))
      )
    }
  };
}

// Classify only from facts issued by this access. Value identities are never
// reverse-engineered: a dynamic offset therefore widens to the whole origin.
export function flatMemoryOperand(
  resource: ResourceRef,
  values: FlatMemoryValues,
  access: MemoryAccess,
  byteOffset: ValueId,
  width: IntegerWidth
): ResourceByteOperand {
  assert(
    width === 8 || width === 16 || width === 32,
    `flat operation width must be 8, 16, or 32, got ${String(width)}`
  );
  const byteLength = width / 8;
  const staticAccessByteLength = values.constValue(access.range.byteLength);
  const staticByteOffset = values.constValue(byteOffset);

  assert(
    staticByteOffset === undefined || staticByteOffset >= 0,
    `memory byte offset must be non-negative, got ${String(staticByteOffset)}`
  );
  assert(
    staticByteOffset === undefined ||
      staticAccessByteLength === undefined ||
      staticByteOffset + byteLength <= staticAccessByteLength,
    `${width}-bit memory access at byte offset ${String(staticByteOffset)} exceeds ${String(staticAccessByteLength)}-byte resolution`
  );
  const range = flatMemoryRange(values, access, staticByteOffset, byteLength);
  const base = staticByteOffset === undefined
    ? values.binary("add", access.range.start, byteOffset)
    : access.range.start;

  return {
    effect: { space: "resource", resource, range },
    address: {
      base,
      displacement: staticByteOffset ?? 0
    },
    width
  };
}

function flatMemoryRange(
  values: ConstantValues,
  access: Pick<MemoryAccess, "origin" | "range">,
  staticByteOffset: number | undefined,
  byteLength: number
): ByteRange {
  if (staticByteOffset === undefined) {
    return { basis: { kind: "dynamic", origin: access.origin } };
  }
  const staticStart = values.constValue(access.range.start);

  if (staticStart !== undefined) {
    const absoluteStart = (staticStart >>> 0) + staticByteOffset;

    if (absoluteStart + byteLength <= addressSpaceByteLength) {
      return {
        basis: { kind: "resource" },
        slice: { byteOffset: absoluteStart, byteLength }
      };
    }
  }

  return {
    basis: { kind: "dynamic", origin: access.origin },
    slice: { byteOffset: staticByteOffset, byteLength }
  };
}
