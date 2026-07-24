import { assert } from "#common/assert.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  pageFault,
  pageFaultErrorCode
} from "#core/exceptions.js";
import { guestMemoryMinimumByteLength } from "./constants.js";
import type {
  PhysicalAccess,
  PhysicalByteReader
} from "./physical.js";
import type {
  GuestMemoryByteRead,
  GuestMemoryReader,
  LinearRange,
  MemoryAccessIntent,
  MemoryReadIntent,
  MemoryResolution
} from "./access.js";

type FlatMemoryValues = Pick<ValueBuilder, "const" | "binary" | "compare"> & ConstantValues;

type ConstantValues = Readonly<{
  constValue(value: ValueId): number | undefined;
}>;

export function createFlatGuestMemoryReader(
  physical: PhysicalByteReader
): GuestMemoryReader {
  return {
    readByte: (address, intent) =>
      readFlatMemoryByte(physical, address, intent)
  };
}

function readFlatMemoryByte(
  physical: PhysicalByteReader,
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

  const value = physical.readByte(address);

  assert(value !== undefined, `checked flat memory byte is absent at ${address}`);
  return { kind: "value", value };
}

export function flatMemoryResolution<TIntent extends MemoryAccessIntent>(
  values: FlatMemoryValues,
  range: LinearRange,
  intent: TIntent,
  physical: PhysicalAccess
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
      intent,
      physical
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
  return createMemoryResolution(values, range, faulted, intent, physical);
}

function createMemoryResolution<TIntent extends MemoryAccessIntent>(
  values: FlatMemoryValues,
  range: LinearRange,
  faulted: ValueId,
  intent: TIntent,
  physical: PhysicalAccess
): MemoryResolution<TIntent> {
  return {
    access: {
      range,
      intent,
      physicalAccess: physical
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
