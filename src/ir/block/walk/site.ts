export type OpSite = Readonly<{
  opIndex: number;
}>;

export function opSite(opIndex: number): OpSite {
  if (!Number.isInteger(opIndex) || opIndex < 0) {
    throw new Error(`block op index must be a non-negative integer: ${opIndex}`);
  }

  return Object.freeze({ opIndex });
}
