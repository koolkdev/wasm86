import { u32 } from "#core/numeric.js";

export type LegacyTransfer =
  | Readonly<{ kind: "dynamicJump" }>
  | Readonly<{ kind: "linkStub"; targetEip: number }>;

// Wire format of the raw JIT link graph. True Cpu exits do not use this
// namespace.
export function encodeTransfer(transfer: LegacyTransfer): bigint {
  switch (transfer.kind) {
    case "dynamicJump":
      return encodeLegacyCompletion(dynamicJumpSubtype, 0);
    case "linkStub":
      return encodeLegacyCompletion(linkStubSubtype, transfer.targetEip);
  }
}

export function decodeTransfer(
  encoded: bigint
): LegacyTransfer | undefined {
  const value = BigInt.asUintN(64, encoded);

  // Derived Cpu exits always have a nonzero tag in these high bits.
  if ((value >> detailShift) !== 0n) {
    return undefined;
  }

  const code = Number((value >> codeShift) & codeMask);
  const payload = Number(value & payloadMask) >>> 0;

  switch (code) {
    case legacyFamilyCode | dynamicJumpSubtype:
      return { kind: "dynamicJump" };
    case legacyFamilyCode | linkStubSubtype:
      return { kind: "linkStub", targetEip: payload };
    default:
      return undefined;
  }
}

function encodeLegacyCompletion(subtype: number, payload: number): bigint {
  const code = legacyFamilyCode | subtype;

  return BigInt.asIntN(64, (BigInt(code) << codeShift) | BigInt(u32(payload)));
}

const payloadMask = 0xffff_ffffn;
const codeMask = 0xffffn;
const codeShift = 32n;
export const transferByteLength = 6;
const detailShift = BigInt(transferByteLength * 8);
const legacyFamilyCode = 0x01 << 8;
const dynamicJumpSubtype = 1;
const linkStubSubtype = 2;
