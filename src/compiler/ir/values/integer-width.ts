import type { WasmInstructionWriter } from "#compiler/encoder/instruction-writer.js";
import type { IntegerWidth } from "./types.js";

export function truncateInteger(width: IntegerWidth, value: number): number {
  switch (width) {
    case 8:
      return value & 0xff;
    case 16:
      return value & 0xffff;
    case 32:
      return value | 0;
  }
}

export function signExtendInteger(width: IntegerWidth, value: number): number {
  switch (width) {
    case 8:
      return (value << 24) >> 24;
    case 16:
      return (value << 16) >> 16;
    case 32:
      return value | 0;
  }
}

// These emitters consume the i32 already on the Wasm stack.
export function emitUnsignedWidth(body: WasmInstructionWriter, width: IntegerWidth): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.i32Const(0xffff);
      body.i32And();
      return;
    case 8:
      body.i32Const(0xff);
      body.i32And();
      return;
  }
}

export function emitSignedWidth(body: WasmInstructionWriter, width: IntegerWidth): void {
  switch (width) {
    case 32:
      return;
    case 16:
      body.i32Extend16S();
      return;
    case 8:
      body.i32Extend8S();
      return;
  }
}
