import type { ValueId } from "#compiler/ir/values/types.js";
import { VariableRef } from "#compiler/ir/variable.js";
import { generalProtection } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import type { OperandWidth } from "#core/types.js";
import { X86_32_DECODE_MODEL } from "#instructions/decoder/model/index.js";
import type { EncodedValue } from "#instructions/decoder/model/types.js";
import type { BuildExit } from "#instructions/lowering/terminal.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type {
  DirectMemoryAccess,
  MemoryAccess
} from "#memory/types.js";

const instructionLengthLimit =
  X86_32_DECODE_MODEL.instructionLengthLimit;

export type InstructionFetchMode =
  | Readonly<{ kind: "exact" }>
  | Readonly<{
      kind: "direct";
      access: DirectMemoryAccess<"instructionFetch">;
    }>;

export class InstructionByteStream {
  readonly #instructionStart: ValueId;
  readonly #cursor: VariableRef;
  readonly #memory: MemoryAccess;
  readonly #fetch: InstructionFetchMode;
  readonly #buildExit: BuildExit;

  constructor(
    region: RegionBuilder,
    instructionStart: ValueId,
    memory: MemoryAccess,
    buildExit: BuildExit,
    fetch: InstructionFetchMode
  ) {
    this.#instructionStart = instructionStart;
    this.#cursor = region.variable(region.values.const(0));
    this.#memory = memory;
    this.#buildExit = buildExit;
    this.#fetch = fetch;
  }

  offset(region: RegionBuilder): ValueId {
    return region.read(this.#cursor);
  }

  readByte(region: RegionBuilder): ValueId {
    return this.#fetch.kind === "direct"
      ? this.#readDirectValue(
        region,
        this.#fetch.access,
        1,
        false
      )
      : this.#readExactByte(region);
  }

  readEncoded(region: RegionBuilder, encoded: EncodedValue): ValueId {
    return this.#fetch.kind === "direct"
      ? this.#readDirectValue(
        region,
        this.#fetch.access,
        encoded.byteLength,
        encoded.signed
      )
      : this.#readExactEncoded(region, encoded);
  }

  #readDirectValue(
    region: RegionBuilder,
    access: DirectMemoryAccess<"instructionFetch">,
    byteLength: EncodedValue["byteLength"],
    signed: boolean
  ): ValueId {
    // PrefixDecoder leaves direct mode before any supported suffix could
    // exceed the already-resolved instruction range.
    const cursor = this.offset(region);
    const width = (byteLength * 8) as OperandWidth;
    const value = this.#memory.bind(region).loadDirect(
      access,
      cursor,
      width,
      { signed }
    );

    this.#advance(region, cursor, byteLength);
    return value;
  }

  #readExactByte(region: RegionBuilder): ValueId {
    const cursor = this.offset(region);

    this.#exitIfLengthLimitReached(region, cursor);
    const values = region.values;
    const address = values.binary("add", this.#instructionStart, cursor);
    const memory = this.#memory.bind(region);
    const resolution = memory.resolve(
      {
        start: address,
        byteLength: values.const(1)
      },
      "instructionFetch"
    );

    region.if(resolution.fault.condition, (fault) => {
      fault.return([
        this.#buildExit(
          fault.values,
          exceptionExit(resolution.fault.exception)
        )
      ]);
    }, { hint: "unlikely" });
    const byte = memory.load(
      resolution.access,
      values.const(0),
      8
    );

    this.#advance(region, cursor, 1);
    return byte;
  }

  #readExactEncoded(
    region: RegionBuilder,
    encoded: EncodedValue
  ): ValueId {
    if (encoded.byteLength === 1) {
      return region.values.widthAdjusted(
        8,
        this.#readExactByte(region),
        encoded.signed
      );
    }
    const cursor = this.offset(region);
    const values = region.values;
    const crossesLimit = values.compare(
      32,
      "gt_u",
      cursor,
      values.const(
        instructionLengthLimit - encoded.byteLength
      )
    );

    // A crossing encoded value is read byte by byte: an unavailable byte
    // below the limit may page-fault before offset 15 produces GP(0).
    return region.ifValue(
      crossesLimit,
      (crossing) =>
        this.#readExactEncodedBytewise(crossing, encoded),
      (withinLimit) =>
        this.#readExactEncodedWithinLimit(
          withinLimit,
          cursor,
          encoded
        ),
      { hint: "unlikely" }
    );
  }

  #readExactEncodedWithinLimit(
    region: RegionBuilder,
    cursor: ValueId,
    encoded: EncodedValue
  ): ValueId {
    const values = region.values;
    const address = values.binary("add", this.#instructionStart, cursor);
    const width = (encoded.byteLength * 8) as OperandWidth;
    const resolution = this.#memory.bind(region).resolve({
      start: address,
      byteLength: values.const(encoded.byteLength)
    }, "instructionFetch");

    // A failed range check is retried byte by byte so Memory identifies the
    // first unavailable instruction address, rather than only the range start.
    return region.ifValue(
      resolution.fault.condition,
      (fault) => this.#readExactEncodedBytewise(fault, encoded),
      (resolved) => {
        const value = this.#memory.bind(resolved).load(
          resolution.access,
          resolved.values.const(0),
          width,
          { signed: encoded.signed }
        );

        this.#advance(resolved, cursor, encoded.byteLength);
        return value;
      },
      { hint: "unlikely" }
    );
  }

  #readExactEncodedBytewise(
    region: RegionBuilder,
    encoded: EncodedValue
  ): ValueId {
    let value = region.values.const(0);

    for (let index = 0; index < encoded.byteLength; index += 1) {
      const byte = this.#readExactByte(region);
      const shift = index * 8;
      const part = shift === 0
        ? byte
        : region.values.binary("shl", byte, region.values.const(shift));

      value = region.values.binary("or", value, part);
    }
    const width = (encoded.byteLength * 8) as OperandWidth;

    return region.values.widthAdjusted(width, value, encoded.signed);
  }

  #exitIfLengthLimitReached(
    region: RegionBuilder,
    cursor: ValueId
  ): void {
    region.if(
      region.values.compare(
        32,
        "ge_u",
        cursor,
        region.values.const(instructionLengthLimit)
      ),
      (tooLong) => {
        tooLong.return([
          this.#buildExit(
            tooLong.values,
            exceptionExit(generalProtection(tooLong.values.const(0)))
          )
        ]);
      },
      { hint: "unlikely" }
    );
  }

  #advance(
    region: RegionBuilder,
    cursor: ValueId,
    byteLength: EncodedValue["byteLength"]
  ): void {
    region.write(
      this.#cursor,
      region.values.binary(
        "add",
        cursor,
        region.values.const(byteLength)
      )
    );
  }
}
