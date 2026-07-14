type CpuExecutionStateField = Readonly<{
  offset: number;
  byteLength: 4;
}>;

export const cpuExecutionStateFields = {
  instructionCount: { offset: 36, byteLength: 4 }
} as const satisfies Readonly<Record<"instructionCount", CpuExecutionStateField>>;
