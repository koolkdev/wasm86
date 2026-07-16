import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuStateSnapshot,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";
import { runCompiledInstructions } from "#test/harness/compiled-instruction.js";

const allFlagsSet = {
  CF: 1,
  PF: 1,
  AF: 1,
  ZF: 1,
  SF: 1,
  OF: 1,
  TF: 1,
  DF: 1,
  NT: 1,
  AC: 1,
  ID: 1
} as const;

type MovRegisterCase = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState: WasmCpuStateInit;
  expectedState: WasmCpuStateInit;
  instructionCount?: number;
}>;

const immediateCases: readonly MovRegisterCase[] = [
  {
    name: "B0 writes an immediate to AL and preserves upper EAX",
    bytes: [0xb0, 0x7f],
    initialState: { eax: 0x1234_5680 },
    expectedState: { eax: 0x1234_567f }
  },
  {
    name: "B4 writes an immediate to AH and preserves adjacent bytes",
    bytes: [0xb4, 0x80],
    initialState: { eax: 0x1234_5678 },
    expectedState: { eax: 0x1234_8078 }
  },
  {
    name: "B7 writes the high-byte boundary register BH",
    bytes: [0xb7, 0xff],
    initialState: { ebx: 0x1122_3344 },
    expectedState: { ebx: 0x1122_ff44 }
  },
  {
    name: "66 B8 writes an immediate to AX and preserves upper EAX",
    bytes: [0x66, 0xb8, 0x01, 0x80],
    initialState: { eax: 0x1234_5678 },
    expectedState: { eax: 0x1234_8001 }
  },
  {
    name: "66 BF writes the word immediate boundary register DI",
    bytes: [0x66, 0xbf, 0xff, 0xff],
    initialState: { edi: 0x7654_3210 },
    expectedState: { edi: 0x7654_ffff }
  },
  {
    name: "B8 writes a full immediate to EAX",
    bytes: [0xb8, 0x78, 0x56, 0x34, 0x12],
    initialState: { eax: 0xaaaa_aaaa },
    expectedState: { eax: 0x1234_5678 }
  },
  {
    name: "BF writes the dword immediate boundary register EDI",
    bytes: [0xbf, 0xff, 0xff, 0xff, 0xff],
    initialState: { edi: 0x7654_3210 },
    expectedState: { edi: 0xffff_ffff }
  }
];

const modRmCases: readonly MovRegisterCase[] = [
  {
    name: "8A copies BH to AL",
    bytes: [0x8a, 0xc7],
    initialState: { eax: 0xaaaa_aa11, ebx: 0x2233_4455 },
    expectedState: { eax: 0xaaaa_aa44 }
  },
  {
    name: "88 copies CL to AH",
    bytes: [0x88, 0xcc],
    initialState: { eax: 0x1234_5678, ecx: 0xabcd_ef80 },
    expectedState: { eax: 0x1234_8078 }
  },
  {
    name: "66 8B copies BX to DX",
    bytes: [0x66, 0x8b, 0xd3],
    initialState: { ebx: 0x1234_8001, edx: 0xaaaa_1111 },
    expectedState: { edx: 0xaaaa_8001 }
  },
  {
    name: "66 89 copies BX to CX",
    bytes: [0x66, 0x89, 0xd9],
    initialState: { ebx: 0x1234_8001, ecx: 0xaaaa_1111 },
    expectedState: { ecx: 0xaaaa_8001 }
  },
  {
    name: "8B copies EBX to EDX",
    bytes: [0x8b, 0xd3],
    initialState: { ebx: 0x8765_4321, edx: 0xaaaa_aaaa },
    expectedState: { edx: 0x8765_4321 }
  },
  {
    name: "89 copies EBX to ECX",
    bytes: [0x89, 0xd9],
    initialState: { ebx: 0x8765_4321, ecx: 0xaaaa_aaaa },
    expectedState: { ecx: 0x8765_4321 }
  }
];

const groupedImmediateCases: readonly MovRegisterCase[] = [
  {
    name: "C6 writes an immediate to AH",
    bytes: [0xc6, 0xc4, 0x80],
    initialState: { eax: 0x1234_5678 },
    expectedState: { eax: 0x1234_8078 }
  },
  {
    name: "66 C7 writes an immediate to CX",
    bytes: [0x66, 0xc7, 0xc1, 0x01, 0x80],
    initialState: { ecx: 0x1234_5678 },
    expectedState: { ecx: 0x1234_8001 }
  },
  {
    name: "C7 writes an immediate to EDX",
    bytes: [0xc7, 0xc2, 0x78, 0x56, 0x34, 0x12],
    initialState: { edx: 0xaaaa_aaaa },
    expectedState: { edx: 0x1234_5678 }
  }
];

const extensionCases: readonly MovRegisterCase[] = [
  {
    name: "MOVZX zero-extends BH into EAX",
    bytes: [0x0f, 0xb6, 0xc7],
    initialState: { eax: 0xaaaa_aaaa, ebx: 0x0000_8000 },
    expectedState: { eax: 0x0000_0080 }
  },
  {
    name: "MOVZX zero-extends AH into AX and preserves upper EAX",
    bytes: [0x66, 0x0f, 0xb6, 0xc4],
    initialState: { eax: 0x1234_ff00 },
    expectedState: { eax: 0x1234_00ff }
  },
  {
    name: "MOVZX zero-extends BX into ECX",
    bytes: [0x0f, 0xb7, 0xcb],
    initialState: { ebx: 0x1234_80ff, ecx: 0xaaaa_aaaa },
    expectedState: { ecx: 0x0000_80ff }
  },
  {
    name: "MOVSX sign-extends BH into EAX",
    bytes: [0x0f, 0xbe, 0xc7],
    initialState: { eax: 0xaaaa_aaaa, ebx: 0x0000_8000 },
    expectedState: { eax: 0xffff_ff80 }
  },
  {
    name: "MOVSX sign-extends AH into AX and preserves upper EAX",
    bytes: [0x66, 0x0f, 0xbe, 0xc4],
    initialState: { eax: 0x1234_8000 },
    expectedState: { eax: 0x1234_ff80 }
  },
  {
    name: "MOVSX sign-extends BX into ECX",
    bytes: [0x0f, 0xbf, 0xcb],
    initialState: { ebx: 0x1234_8001, ecx: 0xaaaa_aaaa },
    expectedState: { ecx: 0xffff_8001 }
  },
  {
    name: "MOVSX preserves a positive byte boundary",
    bytes: [0x0f, 0xbe, 0xd3],
    initialState: { ebx: 0x1234_567f, edx: 0xaaaa_aaaa },
    expectedState: { edx: 0x0000_007f }
  }
];

for (const entry of [
  ...immediateCases,
  ...modRmCases,
  ...groupedImmediateCases,
  ...extensionCases
]) {
  test(`compiled ${entry.name}`, async () => {
    await assertMovRegisterCase(entry);
  });
}

test("compiled MOVSX word result is visible through later byte, word, and dword MOV aliases", async () => {
  await assertMovRegisterCase({
    name: "MOVSX alias sequence",
    bytes: [
      0x66, 0x0f, 0xbe, 0xd8, // movsx bx, al
      0x8a, 0xcb, // mov cl, bl
      0x66, 0x8b, 0xd3, // mov dx, bx
      0x8b, 0xf3 // mov esi, ebx
    ],
    initialState: {
      eax: 0x0000_0080,
      ebx: 0x1122_3344,
      ecx: 0xaaaa_0000,
      edx: 0xbbbb_0000,
      esi: 0xcccc_cccc
    },
    expectedState: {
      ebx: 0x1122_ff80,
      ecx: 0xaaaa_0080,
      edx: 0xbbbb_ff80,
      esi: 0x1122_ff80
    },
    instructionCount: 4
  });
});

test("compiled MOVSX reads a word value written by a preceding narrow MOV", async () => {
  await assertMovRegisterCase({
    name: "MOV to MOVSX dependency",
    bytes: [
      0x66, 0x89, 0xd8, // mov ax, bx
      0x0f, 0xbf, 0xc8 // movsx ecx, ax
    ],
    initialState: {
      eax: 0x1234_0000,
      ebx: 0x0000_8001,
      ecx: 0xcccc_cccc
    },
    expectedState: {
      eax: 0x1234_8001,
      ecx: 0xffff_8001
    },
    instructionCount: 2
  });
});

async function assertMovRegisterCase(entry: MovRegisterCase): Promise<void> {
  const instructionCount = entry.instructionCount ?? 1;
  const initialState = createWasmCpuStateSnapshot({
    ...allFlagsSet,
    eip: startAddress,
    instructionCount: 7,
    ...entry.initialState
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState
  });

  deepStrictEqual(
    result.completion,
    {
      kind: "linkStub",
      targetEip: startAddress + entry.bytes.length
    },
    entry.name
  );
  deepStrictEqual(
    result.state,
    {
      ...initialState,
      ...entry.expectedState,
      eip: startAddress + entry.bytes.length,
      instructionCount: initialState.instructionCount + instructionCount
    },
    entry.name
  );
  deepStrictEqual(result.memory, [], entry.name);
}
