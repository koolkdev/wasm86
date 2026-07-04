import type { SegmentRegister } from "./types.js";

export const operandSizeOverridePrefixByte = 0x66;

export const segmentOverridePrefixSegments: ReadonlyMap<number, SegmentRegister> = new Map([
  [0x26, "es"],
  [0x2e, "cs"],
  [0x36, "ss"],
  [0x3e, "ds"],
  [0x64, "fs"],
  [0x65, "gs"]
]);
