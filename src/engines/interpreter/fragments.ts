import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import { eipChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { memoryGuardActions } from "#ir/memory-guard.js";
import {
  ValueTable,
  fitsUnsigned,
  signExtended,
  type ValueId,
  type WidthBounds
} from "#ir/values.js";
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
  readonly #values = new ValueTable();
  readonly #actions: Action[] = [];
  readonly #externalLocals = new Map<ExternalValueId, number>();
  readonly #externalsByLocal = new Map<number, ValueId>();
  readonly #outputs = new Map<ValueId, number>();
  readonly #cursorOutputs: [ValueId, number][] = [];

  external(local: number): ValueId {
    const existing = this.#externalsByLocal.get(local);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#values.external(this.#externalLocals.size);

    this.#externalLocals.set(this.#externalLocals.size, local);
    this.#externalsByLocal.set(local, id);
    return id;
  }

  const32(value: number): ValueId {
    return this.#values.const(value);
  }

  add(a: ValueId, b: ValueId): ValueId {
    return this.#values.binary("add", a, b);
  }

  extract(value: ValueId, shift: number, mask?: number): ValueId {
    const shifted = shift === 0 ? value : this.#values.binary("shr_u", value, this.const32(shift));

    return mask === undefined ? shifted : this.and(shifted, mask);
  }

  and(value: ValueId, mask: number): ValueId {
    return this.#values.binary("and", value, this.const32(mask));
  }

  readEip(): ValueId {
    const output = this.#values.addActionOutput();

    this.#actions.push({ kind: "op", output, op: { kind: "state.read", slot: eipChannel } });
    return output;
  }

  readGprWord(index: ValueId): ValueId {
    const output = this.#values.addActionOutput();

    this.#actions.push({
      kind: "op",
      output,
      op: { kind: "state.read", slot: { kind: "gprDynamic", index, byteLength: 4 } }
    });
    return output;
  }

  // The scaled-index term: zero when the index field selects "none" (4).
  scaledIndex(index: ValueId, shift: ValueId): ValueId {
    return this.#values.select(
      this.#values.compare("eq", index, this.const32(4)),
      this.const32(0),
      this.#values.binary("shl", this.readGprWord(index), shift)
    );
  }

  // A guarded instruction fetch; the fault body reports the faulting address.
  readGuest(address: ValueId, width: OperandWidth, signed = false): ValueId {
    const byteLength = width / 8;

    this.#actions.push(
      ...memoryGuardActions(this.#values, address, byteLength, { kind: "instructionFetch" })
    );

    const output = this.#values.addActionOutput(decodeReadBounds(width, signed));

    this.#actions.push(
      signed && width !== 32
        ? { kind: "op", output, op: { kind: "memory.read", address, width, signed: true } }
        : { kind: "op", output, op: { kind: "memory.read", address, width } }
    );
    return output;
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

        return { value, cursor: { kind: "static", offset }, cursorEnd: this.const32(offset) };
      }
      case "local": {
        const cursorEnd = this.add(this.external(cursor.local), this.const32(byteLength));

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
      body: { actions: this.#actions },
      values: this.#values
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

function decodeReadBounds(width: OperandWidth, signed: boolean): WidthBounds | undefined {
  if (width === 32) {
    return undefined;
  }

  return signed ? signExtended(width) : fitsUnsigned(width);
}

function cursorAddress(fragment: DecodeFragment, eipLocal: number, cursor: DecodeCursor): ValueId {
  const eip = fragment.external(eipLocal);

  switch (cursor.kind) {
    case "static":
      return cursor.offset === 0 ? eip : fragment.add(eip, fragment.const32(cursor.offset));
    case "local":
      return fragment.add(eip, fragment.external(cursor.local));
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
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, 8);
  const byte = decoded.value;

  fragment.output(fragment.extract(byte, 6), outputs.modLocal);
  fragment.output(fragment.extract(byte, 3, 0b111), outputs.regLocal);
  fragment.output(fragment.extract(byte, 0, 0b111), outputs.rmLocal);
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
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, 8);
  const byte = decoded.value;

  fragment.output(
    fragment.scaledIndex(fragment.extract(byte, 3, 0b111), fragment.extract(byte, 6)),
    outputs.scaledIndexLocal
  );
  fragment.output(fragment.extract(byte, 0, 0b111), outputs.baseLocal);
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
    terms.length === 0 ? fragment.const32(0) : terms.reduce((sum, term) => fragment.add(sum, term)),
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
  const decoded = fragment.readInstructionBytes(eipLocal, cursor, width, true);
  const nextEip = fragment.add(fragment.external(eipLocal), decoded.cursorEnd);
  const target = fragment.add(nextEip, decoded.value);

  fragment.output(width === 16 ? fragment.and(target, 0xffff) : target, targetLocal);
  fragment.emit(context);
  return decoded.cursor;
}
