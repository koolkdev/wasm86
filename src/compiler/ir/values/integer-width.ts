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
