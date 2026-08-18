import { Integer, i32, type I32Value } from "#compiler/function/values.js";
import { VariableRef } from "#compiler/function/storage.js";
import { generalProtection } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import type { OperandWidth } from "#core/types.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { EncodedValue } from "#instructions/decoder/model/types.js";
import type { BuildExit } from "#instructions/lowering/terminal.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { DirectMemoryAccess, MemoryAccess } from "#memory/types.js";

const instructionLengthLimit = X86_32_DECODE_MODEL.instructionLengthLimit;
const encodedWidthByByteLength = {
  1: 8,
  2: 16,
  4: 32
} as const satisfies Readonly<Record<EncodedValue["byteLength"], OperandWidth>>;

export type InstructionFetchMode =
  | Readonly<{ kind: "exact" }>
  | Readonly<{
      kind: "direct";
      access: DirectMemoryAccess<"instructionFetch">;
    }>;

export class InstructionByteStream {
  readonly #instructionStart: I32Value;
  readonly #cursor: VariableRef<(typeof Integer)[32]>;
  readonly #memory: MemoryAccess;
  readonly #fetch: InstructionFetchMode;
  readonly #buildExit: BuildExit;

  constructor(
    region: RegionBuilder,
    instructionStart: I32Value,
    memory: MemoryAccess,
    buildExit: BuildExit,
    fetch: InstructionFetchMode
  ) {
    this.#instructionStart = instructionStart;
    this.#cursor = region.variable(i32(0));
    this.#memory = memory;
    this.#buildExit = buildExit;
    this.#fetch = fetch;
  }

  offset(region: RegionBuilder): I32Value {
    return region.read(this.#cursor);
  }

  readByte(region: RegionBuilder): Integer<8> {
    return this.#fetch.kind === "direct"
      ? this.#readDirectByte(region, this.#fetch.access)
      : this.#readExactByte(region);
  }

  readEncoded(region: RegionBuilder, encoded: EncodedValue): I32Value {
    return this.#fetch.kind === "direct"
      ? this.#readDirectEncoded(region, this.#fetch.access, encoded)
      : this.#readExactEncoded(region, encoded);
  }

  #readDirectByte(
    region: RegionBuilder,
    access: DirectMemoryAccess<"instructionFetch">
  ): Integer<8> {
    // PrefixDecoder leaves direct mode before any supported suffix could
    // exceed the already-resolved instruction range.
    const cursor = this.offset(region);
    const value = this.#memory.forRegion(region).loadDirect(access, cursor, 8);

    this.#advance(region, cursor, 1);
    return value;
  }

  #readDirectEncoded(
    region: RegionBuilder,
    access: DirectMemoryAccess<"instructionFetch">,
    encoded: EncodedValue
  ): I32Value {
    // PrefixDecoder leaves direct mode before any supported suffix could
    // exceed the already-resolved instruction range.
    const cursor = this.offset(region);
    const width = encodedWidthByByteLength[encoded.byteLength];
    const value = this.#memory.forRegion(region).loadDirect(access, cursor, width);

    this.#advance(region, cursor, encoded.byteLength);
    return encoded.signed ? value.signed.extend(32) : value.unsigned.extend(32);
  }

  #readExactByte(region: RegionBuilder): Integer<8> {
    const cursor = this.offset(region);

    this.#exitIfLengthLimitReached(region, cursor);
    const address = this.#instructionStart.add(cursor);
    const memory = this.#memory.forRegion(region);
    const resolution = memory.resolve(
      {
        start: address,
        byteLength: i32(1)
      },
      "instructionFetch"
    );

    region.if(
      resolution.fault.condition,
      (fault) => {
        fault.return([this.#buildExit(exceptionExit(resolution.fault.exception))]);
      },
      { hint: "unlikely" }
    );
    const byte = memory.load(resolution.access, i32(0), 8);

    this.#advance(region, cursor, 1);
    return byte;
  }

  #readExactEncoded(region: RegionBuilder, encoded: EncodedValue): I32Value {
    if (encoded.byteLength === 1) {
      const byte = this.#readExactByte(region);

      return encoded.signed ? byte.signed.extend(32) : byte.unsigned.extend(32);
    }
    const cursor = this.offset(region);
    const crossesLimit = cursor.unsigned.gt(instructionLengthLimit - encoded.byteLength);

    // A crossing encoded value is read byte by byte: an unavailable byte
    // below the limit may page-fault before offset 15 produces GP(0).
    return region.ifValue(
      crossesLimit,
      (crossing) => this.#readExactEncodedBytewise(crossing, encoded),
      (withinLimit) => this.#readExactEncodedWithinLimit(withinLimit, cursor, encoded),
      { hint: "unlikely" }
    );
  }

  #readExactEncodedWithinLimit(
    region: RegionBuilder,
    cursor: I32Value,
    encoded: EncodedValue
  ): I32Value {
    const address = this.#instructionStart.add(cursor);
    const width = encodedWidthByByteLength[encoded.byteLength];
    const resolution = this.#memory.forRegion(region).resolve(
      {
        start: address,
        byteLength: i32(encoded.byteLength)
      },
      "instructionFetch"
    );

    // A failed range check is retried byte by byte so Memory identifies the
    // first unavailable instruction address, rather than only the range start.
    return region.ifValue(
      resolution.fault.condition,
      (fault) => this.#readExactEncodedBytewise(fault, encoded),
      (resolved) => {
        const value = this.#memory.forRegion(resolved).load(resolution.access, i32(0), width);

        this.#advance(resolved, cursor, encoded.byteLength);
        return encoded.signed ? value.signed.extend(32) : value.unsigned.extend(32);
      },
      { hint: "unlikely" }
    );
  }

  #readExactEncodedBytewise(region: RegionBuilder, encoded: EncodedValue): I32Value {
    let value = i32(0);

    for (let index = 0; index < encoded.byteLength; index += 1) {
      const byte = this.#readExactByte(region);
      const shift = index * 8;
      const part = byte.unsigned.extend(32).shl(shift);

      value = value.or(part);
    }
    const width = encodedWidthByByteLength[encoded.byteLength];
    const encodedValue = value.truncate(width);

    return encoded.signed ? encodedValue.signed.extend(32) : encodedValue.unsigned.extend(32);
  }

  #exitIfLengthLimitReached(region: RegionBuilder, cursor: I32Value): void {
    region.if(
      cursor.unsigned.ge(instructionLengthLimit),
      (tooLong) => {
        tooLong.return([this.#buildExit(exceptionExit(generalProtection(i32(0))))]);
      },
      { hint: "unlikely" }
    );
  }

  #advance(region: RegionBuilder, cursor: I32Value, byteLength: EncodedValue["byteLength"]): void {
    region.write(this.#cursor, cursor.add(byteLength));
  }
}
