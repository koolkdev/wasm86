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
import { emitActionFragment } from "#wasm/emit/emit.js";
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

  output(value: ValueId, local: number): void {
    assert(!this.#outputs.has(value), "decode fragment already exports this value");
    this.#outputs.set(value, local);
  }

  emit(context: FragmentEmitContext): void {
    const block: IrBlock = {
      body: { actions: this.#actions },
      values: this.#values
    };

    emitActionFragment(block, {
      body: context.body,
      scratch: context.scratch,
      externalLocals: this.#externalLocals,
      helpers: context.helpers,
      embedding: { fallthrough: { kind: "fallthrough" }, outputs: this.#outputs }
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
  offset: number,
  byteLocal: number
): void {
  const fragment = new DecodeFragment();

  fragment.output(
    fragment.readGuest(cursorAddress(fragment, eipLocal, { kind: "static", offset }), 8),
    byteLocal
  );
  fragment.emit(context);
}

// The ModRM byte, exported as its three fields.
export function emitModRmFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  offset: number,
  outputs: Readonly<{ modLocal: number; regLocal: number; rmLocal: number }>
): void {
  const fragment = new DecodeFragment();
  const byte = fragment.readGuest(cursorAddress(fragment, eipLocal, { kind: "static", offset }), 8);

  fragment.output(fragment.extract(byte, 6), outputs.modLocal);
  fragment.output(fragment.extract(byte, 3, 0b111), outputs.regLocal);
  fragment.output(fragment.extract(byte, 0, 0b111), outputs.rmLocal);
  fragment.emit(context);
}

// The SIB byte, exported as the scaled-index term and the base field.
export function emitSibFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  offset: number,
  outputs: Readonly<{ scaledIndexLocal: number; baseLocal: number }>
): void {
  const fragment = new DecodeFragment();
  const byte = fragment.readGuest(cursorAddress(fragment, eipLocal, { kind: "static", offset }), 8);

  fragment.output(
    fragment.scaledIndex(fragment.extract(byte, 3, 0b111), fragment.extract(byte, 6)),
    outputs.scaledIndexLocal
  );
  fragment.output(fragment.extract(byte, 0, 0b111), outputs.baseLocal);
  fragment.emit(context);
}

// The state-independent terms of one ModRM address case — scaled index,
// displacement; the base register is not a term. The empty sum is const 0.
export type RmAddressParts = Readonly<{
  scaledIndexLocal?: number;
  displacement?: Readonly<{ offset: number; width: 8 | 32 }>;
}>;

export function emitRmAddressFragment(
  context: FragmentEmitContext,
  eipLocal: number,
  parts: RmAddressParts,
  offsetLocal: number
): void {
  const fragment = new DecodeFragment();
  const terms: ValueId[] = [];

  if (parts.scaledIndexLocal !== undefined) {
    terms.push(fragment.external(parts.scaledIndexLocal));
  }

  if (parts.displacement !== undefined) {
    terms.push(
      fragment.readGuest(
        cursorAddress(fragment, eipLocal, { kind: "static", offset: parts.displacement.offset }),
        parts.displacement.width,
        parts.displacement.width === 8
      )
    );
  }

  fragment.output(
    terms.length === 0 ? fragment.const32(0) : terms.reduce((sum, term) => fragment.add(sum, term)),
    offsetLocal
  );
  fragment.emit(context);
}

// An immediate operand, sign-extended at decode when the spec says so.
export function emitImmediateFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  cursor: DecodeCursor,
  width: OperandWidth,
  signExtend: boolean,
  valueLocal: number
): void {
  const fragment = new DecodeFragment();

  fragment.output(
    fragment.readGuest(cursorAddress(fragment, eipLocal, cursor), width, signExtend),
    valueLocal
  );
  fragment.emit(context);
}

// A rel operand resolved to its absolute target: nextEip plus the
// sign-extended displacement.
export function emitRelTargetFetch(
  context: FragmentEmitContext,
  eipLocal: number,
  offset: number,
  width: 8 | 16 | 32,
  instructionLength: number,
  targetLocal: number
): void {
  const fragment = new DecodeFragment();
  const displacement = fragment.readGuest(
    cursorAddress(fragment, eipLocal, { kind: "static", offset }),
    width,
    true
  );
  const nextEip = fragment.add(fragment.external(eipLocal), fragment.const32(instructionLength));
  const target = fragment.add(nextEip, displacement);

  fragment.output(width === 16 ? fragment.and(target, 0xffff) : target, targetLocal);
  fragment.emit(context);
}
