import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import { eipChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import type { EdgeRegion, IrBlock, RegionId } from "#ir/block.js";
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

// Decode reads as action fragments: a guarded guest fetch is guardMemory +
// readMemory with a decode-fault edge, and the decoded values leave through
// exported outputs. This file builds the blocks; everything is emitted by
// the action emitter and fragment bodies fall through naturally.

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

const entryRegionId: RegionId = 0;

class DecodeFragment {
  readonly #values = new ValueTable();
  readonly #actions: Action[] = [];
  readonly #edges: EdgeRegion[] = [];
  readonly #externalLocals = new Map<ExternalValueId, number>();
  readonly #externalsByLocal = new Map<number, ValueId>();
  readonly #outputs = new Map<ValueId, number>();

  external(local: number): ValueId {
    const existing = this.#externalsByLocal.get(local);

    if (existing !== undefined) {
      return existing;
    }

    const id = this.#values.internExternal(this.#externalLocals.size);

    this.#externalLocals.set(this.#externalLocals.size, local);
    this.#externalsByLocal.set(local, id);
    return id;
  }

  const32(value: number): ValueId {
    return this.#values.internConst(value);
  }

  add(a: ValueId, b: ValueId): ValueId {
    return this.#values.internBinary("add", a, b);
  }

  shiftField(value: ValueId, shift: number, mask?: number): ValueId {
    const shifted = shift === 0 ? value : this.#values.internBinary("shr_u", value, this.const32(shift));

    return mask === undefined ? shifted : this.#values.internBinary("and", shifted, this.const32(mask));
  }

  readEip(): ValueId {
    const output = this.#values.addActionOutput();

    this.#actions.push({ kind: "readState", output, slot: eipChannel });
    return output;
  }

  readGprWord(index: ValueId): ValueId {
    const output = this.#values.addActionOutput();

    this.#actions.push({ kind: "readState", output, slot: { kind: "gprDynamic", index, byteLength: 4 } });
    return output;
  }

  // The scaled-index term: zero when the index field selects "none" (4).
  scaledIndex(index: ValueId, shift: ValueId): ValueId {
    return this.#values.internSelect(
      this.#values.internCompare("eq", index, this.const32(4)),
      this.const32(0),
      this.#values.internBinary("shl", this.readGprWord(index), shift)
    );
  }

  // A guarded guest fetch; the fault edge reports the faulting address.
  readGuest(address: ValueId, width: OperandWidth, signed = false): ValueId {
    const faultEdge = this.#edges.length + 1;

    this.#edges.push({
      id: faultEdge,
      kind: "edge",
      flushes: [],
      terminator: { kind: "exit", reason: "decodeFault", payload: address }
    });
    this.#actions.push({ kind: "guardMemory", address, byteLength: width / 8, access: "read", faultEdge });

    const output = this.#values.addActionOutput(decodeReadBounds(width, signed));

    this.#actions.push(
      signed && width !== 32
        ? { kind: "readMemory", output, address, width, signed: true }
        : { kind: "readMemory", output, address, width }
    );
    return output;
  }

  output(value: ValueId, local: number): void {
    assert(!this.#outputs.has(value), "decode fragment already exports this value");
    this.#outputs.set(value, local);
  }

  emit(context: FragmentEmitContext): void {
    const block: IrBlock = {
      entry: entryRegionId,
      regions: [
        {
          id: entryRegionId,
          kind: "entry",
          actions: this.#actions
        },
        ...this.#edges
      ],
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

  fragment.output(fragment.shiftField(byte, 6), outputs.modLocal);
  fragment.output(fragment.shiftField(byte, 3, 0b111), outputs.regLocal);
  fragment.output(fragment.shiftField(byte, 0, 0b111), outputs.rmLocal);
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
    fragment.scaledIndex(fragment.shiftField(byte, 3, 0b111), fragment.shiftField(byte, 6)),
    outputs.scaledIndexLocal
  );
  fragment.output(fragment.shiftField(byte, 0, 0b111), outputs.baseLocal);
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
  width: 8 | 32,
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

  fragment.output(fragment.add(nextEip, displacement), targetLocal);
  fragment.emit(context);
}
