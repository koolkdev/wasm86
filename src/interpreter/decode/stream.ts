import type { ValueId } from "#compiler/ir/values/types.js";
import { CellRef } from "#compiler/ir/cell.js";
import type { EncodedValue } from "#core/decoder/model/types.js";
import { exceptionExit } from "#core/exits.js";
import type { BuildExit } from "#core/instruction/terminal.js";
import type { OperandWidth } from "#core/types.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { MemoryAccessConstruction } from "#memory/access.js";

export class InstructionByteStream {
  readonly #instructionStart: ValueId;
  readonly #cursor: CellRef;
  readonly #memory: MemoryAccessConstruction;
  readonly #buildExit: BuildExit;

  constructor(
    region: RegionBuilder,
    instructionStart: ValueId,
    memory: MemoryAccessConstruction,
    buildExit: BuildExit
  ) {
    this.#instructionStart = instructionStart;
    this.#cursor = region.cell(region.values.const(0));
    this.#memory = memory;
    this.#buildExit = buildExit;
  }

  offset(region: RegionBuilder): ValueId {
    return region.read(this.#cursor);
  }

  readByte(region: RegionBuilder): ValueId {
    const values = region.values;
    const cursor = this.offset(region);
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

    region.write(
      this.#cursor,
      values.binary("add", cursor, values.const(1))
    );
    return byte;
  }

  readEncoded(region: RegionBuilder, encoded: EncodedValue): ValueId {
    if (encoded.byteLength === 1) {
      return region.values.widthAdjusted(
        8,
        this.readByte(region),
        encoded.signed
      );
    }
    const values = region.values;
    const cursor = this.offset(region);
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
      (fallback) => this.#readEncodedBytewise(fallback, encoded),
      (fast) => {
        const value = this.#memory.bind(fast).load(
          resolution.access,
          fast.values.const(0),
          width,
          { signed: encoded.signed }
        );

        fast.write(
          this.#cursor,
          fast.values.binary("add", cursor, fast.values.const(encoded.byteLength))
        );
        return value;
      },
      { hint: "unlikely" }
    );
  }

  #readEncodedBytewise(
    region: RegionBuilder,
    encoded: EncodedValue
  ): ValueId {
    let value = region.values.const(0);

    for (let index = 0; index < encoded.byteLength; index += 1) {
      const byte = this.readByte(region);
      const shift = index * 8;
      const part = shift === 0
        ? byte
        : region.values.binary("shl", byte, region.values.const(shift));

      value = region.values.binary("or", value, part);
    }
    const width = (encoded.byteLength * 8) as OperandWidth;

    return region.values.widthAdjusted(width, value, encoded.signed);
  }
}
