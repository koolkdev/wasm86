import { X86_32_CORE } from "#core/isa/x86-32.js";

export type JitBlockPolicy = Readonly<{
  instructionLimit: number;
}>;

export const defaultJitBlockPolicy: JitBlockPolicy = {
  instructionLimit: 64
};

export function jitSnapshotRequestByteLength(
  policy: JitBlockPolicy
): number {
  return policy.instructionLimit * X86_32_CORE.instructionLengthLimit;
}
