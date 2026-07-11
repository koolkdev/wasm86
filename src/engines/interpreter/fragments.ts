import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import { eipChannel } from "#ir/slots.js";
import { BodyBuilder } from "#ir/body-builder.js";
import type { IrBlock } from "#ir/block.js";
import { memoryGuardActions } from "#ir/memory-guard.js";
import { ValueTable } from "#ir/value-table.js";
import type { ValueId } from "#ir/values.js";
import type { OperandWidth } from "#x86/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { emitActionFragment } from "#wasm/emit/action.js";
import type { WasmHelperRegistry } from "#wasm/helpers/module.js";

// Decode reads as action fragments: a guarded instruction fetch is memory.check +
// if + memory.read with a decode-fault body, and the decoded values leave
// through exported outputs. This file builds the blocks; everything is
// emitted by the action emitter and fragment bodies fall through naturally.

export type FragmentEmitContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  helpers?: WasmHelperRegistry | undefined;
}>;

// Byte offset of the next undecoded byte from the instruction start: a
// constant until a runtime-sized displacement makes it a local.
export type DecodeCursor =
  | Readonly<{ kind: "static"; offset: number }>
  | Readonly<{ kind: "local"; local: number }>;

class DecodeFragment {
  readonly #builder = new BodyBuilder(new ValueTable());
  readonly #externalLocals = new Map<ExternalValueId, number>();
  readonly #externalsByLocal = new Map<number, ValueId>();
  readonly #outputs = new Map<ValueId, number>();
  readonly #cursorOutputs: [ValueId, number][] = [];

  get values(): ValueTable {
    return this.#builder.values;
  }

  external(local: number): ValueId {
    const existing = this.#externalsByLocal.get(local);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.values.external(this.#externalLocals.size);

    this.#externalLocals.set(this.#externalLocals.size, local);
    this.#externalsByLocal.set(local, id);
    return id;
  }

  readEip(): ValueId {
    return this.#builder.opValue({ kind: "state.read", slot: eipChannel });
  }

  readGprWord(index: ValueId): ValueId {
    return this.#builder.opValue({
      kind: "state.read",
      slot: { kind: "gprDynamic", index, byteLength: 4 }
    });
  }

  // The scaled-index term: zero when the index field selects "none" (4).
  scaledIndex(index: ValueId, shift: ValueId): ValueId {
    return this.values.select(
      this.values.compare(32, "eq", index, this.values.const(4)),
      this.values.const(0),
      this.values.binary("shl", this.readGprWord(index), shift)
    );
  }

  // A guarded instruction fetch; the fault body reports the faulting address.
  readGuest(address: ValueId, width: OperandWidth, signed = false): ValueId {
    const byteLength = width / 8;

    for (const action of memoryGuardActions(this.values, address, byteLength, { kind: "instructionFetch" })) {
      this.#builder.push(action);
    }

    return this.#builder.opValue(
      signed && width !== 32
        ? { kind: "memory.read", address, byteOffset: 0, width, signed: true }
        : { kind: "memory.read", address, byteOffset: 0, width }
    );
  }

  readInstructionBytes(
    eipLocal: number,
    cursor: DecodeCursor,
    width: OperandWidth,
    signed = false
  ): Readonly<{ value: ValueId; cursor: DecodeCursor; cursorEnd: ValueId }> {
    const byteLength = width / 8;
    const value = this.readGuest(cursorAddress(this, eipLocal, cursor), width, signed);

    switch (cursor.kind) {
      case "static": {
        const offset = cursor.offset + byteLength;

        return { value, cursor: { kind: "static", offset }, cursorEnd: this.values.const(offset) };
      }
      case "local": {
        const cursorEnd = this.values.binary(
          "add",
          this.external(cursor.local),
          this.values.const(byteLength)
        );

        assert(
          !this.#cursorOutputs.some(([, local]) => local === cursor.local),
          "decode fragment advanced the same cursor local more than once"
        );
        this.#cursorOutputs.push([cursorEnd, cursor.local]);
        return { value, cursor, cursorEnd };
      }
    }
  }

  output(value: ValueId, local: number): void {
    assert(!this.#outputs.has(value), "decode fragment already exports this value");
    this.#outputs.set(value, local);
  }

  emit(context: FragmentEmitContext): void {
    const block: IrBlock = {
      body: this.#builder.build(),
      values: this.values
    };
    const outputs = new Map(this.#outputs);

    for (const [id, local] of this.#cursorOutputs) {
      assert(!outputs.has(id), "decode fragment already exports this cursor value");
      outputs.set(id, local);
    }

    emitActionFragment(block, {
      body: context.body,
      scratch: context.scratch,
      externalLocals: this.#externalLocals,
      helpers: context.helpers,
      embedding: { fallthrough: { kind: "fallthrough" }, outputs }
    });
  }
}

function cursorAddress(fragment: DecodeFragment, eipLocal: number, cursor: DecodeCursor): ValueId {
  const eip = fragment.external(eipLocal);

  switch (cursor.kind) {
    case "static":
      return cursor.offset === 0
        ? eip
        : fragment.values.binary("add", eip, fragment.values.const(cursor.offset));
    case "local":
      return fragment.values.binary("add", eip, fragment.external(cursor.local));
  }
}

// The first instruction byte: eip leaves cpu state memory here and is exported
// alongside the byte for the rest of the iteration.
export function emitOpcodeFetch(
  context: FragmentEmitContext,
  outputs: Readonly<{ eipLocal: number; byteLocal: number }>
): void {
  const fragment = new DecodeFragment();
  const eip = fragment.readEip();

  fragment.output(eip, outputs.eipLocal);
  fragment.output(fragment.readGuest(eip, 8), outputs.byteLocal);
  fragment.emit(context);
}

// A later opcode byte (multi-byte opcodes).
export function emitOpcodeByteFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  byteLocal: number
): DecodeCursor {
  const fragment = new DecodeFragment();
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, 8);

  fragment.output(decoded.value, byteLocal);
  fragment.emit(context);
  return decoded.cursor;
}

// The ModRM byte, exported as its three fields.
export function emitModRmFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  outputs: Readonly<{ modLocal: number; regLocal: number; rmLocal: number }>
): DecodeCursor {
  const fragment = new DecodeFragment();
  const values = fragment.values;
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, 8);
  const byte = decoded.value;

  fragment.output(values.binary("shr_u", byte, values.const(6)), outputs.modLocal);
  fragment.output(
    values.binary("and", values.binary("shr_u", byte, values.const(3)), values.const(0b111)),
    outputs.regLocal
  );
  fragment.output(values.binary("and", byte, values.const(0b111)), outputs.rmLocal);
  fragment.emit(context);
  return decoded.cursor;
}

// The SIB byte, exported as the scaled-index term and the base field.
export function emitSibFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  outputs: Readonly<{ scaledIndexLocal: number; baseLocal: number }>
): DecodeCursor {
  const fragment = new DecodeFragment();
  const values = fragment.values;
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, 8);
  const byte = decoded.value;

  fragment.output(
    fragment.scaledIndex(
      values.binary("and", values.binary("shr_u", byte, values.const(3)), values.const(0b111)),
      values.binary("shr_u", byte, values.const(6))
    ),
    outputs.scaledIndexLocal
  );
  fragment.output(values.binary("and", byte, values.const(0b111)), outputs.baseLocal);
  fragment.emit(context);
  return decoded.cursor;
}

// The state-independent terms of one ModRM address case — scaled index,
// displacement; the base register is not a term. The empty sum is const 0.
export type RmAddressParts = Readonly<{
  scaledIndexLocal?: number;
  displacement?: Readonly<{ width: 8 | 32 }>;
}>;

export function emitRmAddressFragment(
  context: FragmentEmitContext,
  eipLocal: number,
  parts: RmAddressParts,
  cursor: DecodeCursor,
  offsetLocal: number
): DecodeCursor {
  const fragment = new DecodeFragment();
  const values = fragment.values;
  const terms: ValueId[] = [];
  let nextCursor = cursor;

  if (parts.scaledIndexLocal !== undefined) {
    terms.push(fragment.external(parts.scaledIndexLocal));
  }

  if (parts.displacement !== undefined) {
    const decoded = fragment.readInstructionBytes(
      eipLocal,
      cursor,
      parts.displacement.width,
      parts.displacement.width === 8
    );

    terms.push(decoded.value);
    nextCursor = decoded.cursor;
  }

  fragment.output(
    terms.length === 0
      ? values.const(0)
      : terms.reduce((sum, term) => values.binary("add", sum, term)),
    offsetLocal
  );
  fragment.emit(context);
  return nextCursor;
}

// An immediate operand, sign-extended at decode when the spec says so.
export function emitImmediateFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  width: OperandWidth,
  signExtend: boolean,
  valueLocal: number
): DecodeCursor {
  const fragment = new DecodeFragment();
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, width, signExtend);

  fragment.output(decoded.value, valueLocal);
  fragment.emit(context);
  return decoded.cursor;
}

// A rel operand resolved to its absolute target: nextEip plus the
// sign-extended displacement. The read's cursor end is the decoded length,
// so nextEip needs no separately tracked instruction length.
export function emitRelTargetFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  width: 8 | 16 | 32,
  targetLocal: number
): DecodeCursor {
  const fragment = new DecodeFragment();
  const values = fragment.values;
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, width, true);
  const nextEip = values.binary("add", fragment.external(eipLocal), decoded.cursorEnd);
  const target = values.binary("add", nextEip, decoded.value);

  fragment.output(
    width === 16 ? values.binary("and", target, values.const(0xffff)) : target,
    targetLocal
  );
  fragment.emit(context);
  return decoded.cursor;
}
