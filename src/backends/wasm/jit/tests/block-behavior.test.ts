import {
  deepStrictEqual,
  strictEqual,
  test,
  createCpuState,
  getFlag,
  ExitReason,
  runJitIrBlock,
  startAddress,
  preservedEflags,
  allArithmeticEflags,
  zeroFlag,
  addWraparoundEflags,
  subBorrowEflags,
  zeroResultEflags,
  assertArithmeticFlags,
  arithmeticEflags,
  littleEndianBytes,
  readGuestValue,
  type ArithmeticFlagExpectations,
} from "./block-test-helpers.js";
test("jit IR block emits mov r32, imm32 with static operands", async () => {
  const result = await runJitIrBlock([0xb8, 0x78, 0x56, 0x34, 0x12], createCpuState({ eip: startAddress }));

  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 5 });
});

test("jit IR block continues through fallthrough instructions until a control exit", async () => {
  const result = await runJitIrBlock(
    [
      0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
      0x83, 0xc0, 0x01, // add eax, 1
      0x83, 0xc0, 0x01, // add eax, 1
      0xcd, 0x2e // int 0x2e
    ],
    createCpuState({ eip: startAddress })
  );

  strictEqual(result.state.eax, 3);
  strictEqual(result.state.eip, startAddress + 13);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits memory mov with static effective addresses", async () => {
  const load = await runJitIrBlock(
    [0x8b, 0x43, 0x04],
    createCpuState({ ebx: 0x2000, eip: startAddress }),
    [{ address: 0x2004, bytes: [0x78, 0x56, 0x34, 0x12] }]
  );

  strictEqual(load.state.eax, 0x1234_5678);

  const store = await runJitIrBlock(
    [0x89, 0x43, 0x08],
    createCpuState({ eax: 0xaabb_ccdd, ebx: 0x2000, eip: startAddress })
  );

  strictEqual(store.guestView.getUint32(0x2008, true), 0xaabb_ccdd);

  const storeImmediate = await runJitIrBlock(
    [0xc7, 0x43, 0x0c, 0x78, 0x56, 0x34, 0x12],
    createCpuState({ ebx: 0x2000, eip: startAddress })
  );

  strictEqual(storeImmediate.guestView.getUint32(0x200c, true), 0x1234_5678);
});

test("jit IR block handles partial register MOV writes", async () => {
  const movAl = await runJitIrBlock([0xb0, 0x44], createCpuState({
    eax: 0x1122_3300,
    eip: startAddress
  }));
  const movAh = await runJitIrBlock([0xb4, 0x55], createCpuState({
    eax: 0x1122_0033,
    eip: startAddress
  }));
  const movAx = await runJitIrBlock([0x66, 0xb8, 0x78, 0x56], createCpuState({
    eax: 0x1234_0000,
    eip: startAddress
  }));

  strictEqual(movAl.state.eax, 0x1122_3344);
  strictEqual(movAh.state.eax, 0x1122_5533);
  strictEqual(movAx.state.eax, 0x1234_5678);
});

test("jit IR block emits register-only xchg forms after reading both operands", async () => {
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    initial: ReturnType<typeof createCpuState>;
    expected: Pick<ReturnType<typeof createCpuState>, "eax" | "ebx" | "eflags">;
  }>[] = [
    {
      name: "xchg eax, ebx",
      bytes: [0x87, 0xd8],
      initial: createCpuState({
        eax: 0x1111_1111,
        ebx: 0x2222_2222,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x2222_2222, ebx: 0x1111_1111, eflags: preservedEflags }
    },
    {
      name: "xchg al, bl",
      bytes: [0x86, 0xd8],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_56dd, ebx: 0xaabb_cc78, eflags: preservedEflags }
    },
    {
      name: "xchg ax, bx",
      bytes: [0x66, 0x87, 0xd8],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_ccdd, ebx: 0xaabb_5678, eflags: preservedEflags }
    },
    {
      name: "xchg al, ah",
      bytes: [0x86, 0xe0],
      initial: createCpuState({
        eax: 0x1234_5678,
        ebx: 0xaabb_ccdd,
        eflags: preservedEflags,
        eip: startAddress
      }),
      expected: { eax: 0x1234_7856, ebx: 0xaabb_ccdd, eflags: preservedEflags }
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(entry.bytes, entry.initial);

    strictEqual(result.state.eax, entry.expected.eax, entry.name);
    strictEqual(result.state.ebx, entry.expected.ebx, entry.name);
    strictEqual(result.state.eflags, entry.expected.eflags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block captures xchg-style parallel exit stores before state writes", async () => {
  const result = await runJitIrBlock([
    0x87, 0xd8, // xchg eax, ebx
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x1111_1111);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits same-register xchg forms as flagless no-ops", async () => {
  const cases: readonly Readonly<{ name: string; bytes: readonly number[] }>[] = [
    { name: "xchg eax, eax", bytes: [0x87, 0xc0] },
    { name: "xchg ax, ax", bytes: [0x66, 0x87, 0xc0] },
    { name: "xchg al, al", bytes: [0x86, 0xc0] },
    { name: "xchg ah, ah", bytes: [0x86, 0xe4] }
  ];

  for (const entry of cases) {
    const initial = createCpuState({
      eax: 0x1234_5678,
      ebx: 0xaabb_ccdd,
      eflags: preservedEflags,
      eip: startAddress
    });
    const result = await runJitIrBlock(entry.bytes, initial);

    strictEqual(result.state.eax, initial.eax, entry.name);
    strictEqual(result.state.ebx, initial.ebx, entry.name);
    strictEqual(result.state.eflags, preservedEflags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
  }
});

test("jit IR block emits memory xchg forms after reading memory and register operands", async () => {
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    initial: ReturnType<typeof createCpuState>;
    memoryValue: number;
    expected: Pick<ReturnType<typeof createCpuState>, "eax" | "ebx" | "eflags">;
    expectedMemoryValue: number;
  }>[] = [
    {
      name: "xchg [eax], ebx",
      bytes: [0x87, 0x18],
      width: 32,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x1122_3344,
      expected: { eax: 0x20, ebx: 0x1122_3344, eflags: preservedEflags },
      expectedMemoryValue: 0xaabb_ccdd
    },
    {
      name: "xchg [eax], bl",
      bytes: [0x86, 0x18],
      width: 8,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x78,
      expected: { eax: 0x20, ebx: 0xaabb_cc78, eflags: preservedEflags },
      expectedMemoryValue: 0xdd
    },
    {
      name: "xchg [eax], bx",
      bytes: [0x66, 0x87, 0x18],
      width: 16,
      initial: createCpuState({ eax: 0x20, ebx: 0xaabb_ccdd, eflags: preservedEflags, eip: startAddress }),
      memoryValue: 0x1357,
      expected: { eax: 0x20, ebx: 0xaabb_1357, eflags: preservedEflags },
      expectedMemoryValue: 0xccdd
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      entry.initial,
      [{ address: entry.initial.eax, bytes: littleEndianBytes(entry.memoryValue, entry.width) }]
    );

    strictEqual(result.state.eax, entry.expected.eax, entry.name);
    strictEqual(result.state.ebx, entry.expected.ebx, entry.name);
    strictEqual(result.state.eflags, entry.expected.eflags, entry.name);
    strictEqual(readGuestValue(result.guestView, entry.initial.eax, entry.width), entry.expectedMemoryValue, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block exits on XCHG memory read fault before changing registers", async () => {
  const initial = createCpuState({
    eax: 0x1_0000,
    ebx: 0x2222_2222,
    eflags: preservedEflags,
    eip: startAddress,
    instructionCount: 7
  });
  const result = await runJitIrBlock([0x87, 0x18], initial);

  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
  strictEqual(result.state.eax, initial.eax);
  strictEqual(result.state.ebx, initial.ebx);
  strictEqual(result.state.eflags, initial.eflags);
  strictEqual(result.state.eip, initial.eip);
  strictEqual(result.state.instructionCount, initial.instructionCount);
});

test("jit IR block preserves XCHG swap ordering for tracked values", async () => {
  const bytes = [
    0xb8, 0x11, 0x11, 0x11, 0x11, // mov eax, 0x11111111
    0xbb, 0x22, 0x22, 0x22, 0x22, // mov ebx, 0x22222222
    0x87, 0xd8 // xchg eax, ebx
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0,
    ebx: 0,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x1111_1111);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block preserves chained XCHG register cycles", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb, // xchg ebx, ecx
    0x87, 0xc1, // xchg ecx, eax
    0x87, 0xd9 // xchg ecx, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.eax);
  strictEqual(result.state.ebx, initial.ebx);
  strictEqual(result.state.ecx, initial.ecx);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block preserves value-changing XCHG register cycles", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb // xchg ebx, ecx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.ecx);
  strictEqual(result.state.ecx, initial.eax);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit Wasm register state preserves a chained XCHG register cycle", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x87, 0xcb // xchg ebx, ecx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    ecx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.ecx);
  strictEqual(result.state.ecx, initial.eax);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block materializes XCHG state before later memory faults", async () => {
  const bytes = [
    0x87, 0xd8, // xchg eax, ebx
    0x8b, 0x15, 0x00, 0x00, 0x01, 0x00, // mov edx, [0x10000]
    0x87, 0xd8 // xchg eax, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_1111,
    ebx: 0x2222_2222,
    edx: 0x3333_3333,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, initial.ebx);
  strictEqual(result.state.ebx, initial.eax);
  strictEqual(result.state.edx, initial.edx);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x1_0000, detail: 4 });
});

test("jit IR block keeps partial XCHG before full XCHG conservative", async () => {
  const bytes = [
    0x86, 0xd8, // xchg al, bl
    0x87, 0xd8 // xchg eax, ebx
  ];
  const initial = createCpuState({
    eax: 0x1111_11aa,
    ebx: 0x2222_22bb,
    eip: startAddress
  });
  const result = await runJitIrBlock(bytes, initial);

  strictEqual(result.state.eax, 0x2222_22aa);
  strictEqual(result.state.ebx, 0x1111_11bb);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block emits movzx and movsx without modifying flags", async () => {
  const movzxByte = await runJitIrBlock([0x0f, 0xb6, 0xc7], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0x1234_807f,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movsxByte = await runJitIrBlock([0x0f, 0xbe, 0xcf], createCpuState({
    ebx: 0x1234_807f,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movzxWordDestination = await runJitIrBlock([0x66, 0x0f, 0xb6, 0xc3], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x80,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const movsxWordDestination = await runJitIrBlock([0x66, 0x0f, 0xbe, 0xc3], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x80,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(movzxByte.state.eax, 0x80);
  strictEqual(movzxByte.state.eflags, preservedEflags);
  strictEqual(movzxByte.state.eip, startAddress + 3);
  strictEqual(movzxByte.state.instructionCount, 1);

  strictEqual(movsxByte.state.ecx, 0xffff_ff80);
  strictEqual(movsxByte.state.eflags, preservedEflags);
  strictEqual(movsxByte.state.eip, startAddress + 3);
  strictEqual(movsxByte.state.instructionCount, 1);

  strictEqual(movzxWordDestination.state.eax, 0x1234_0080);
  strictEqual(movzxWordDestination.state.eflags, preservedEflags);
  strictEqual(movzxWordDestination.state.eip, startAddress + 4);
  strictEqual(movzxWordDestination.state.instructionCount, 1);

  strictEqual(movsxWordDestination.state.eax, 0x1234_ff80);
  strictEqual(movsxWordDestination.state.eflags, preservedEflags);
  strictEqual(movsxWordDestination.state.eip, startAddress + 4);
  strictEqual(movsxWordDestination.state.instructionCount, 1);
});

test("jit IR block preserves MOVSX r16 result across BL/BX/EBX alias operations", async () => {
  const bytes = [
    0x66, 0x0f, 0xbe, 0xd8, // movsx bx, al
    0x80, 0xc3, 0x01, // add bl, 1
    0x66, 0x83, 0xc3, 0x01, // add bx, 1
    0x83, 0xc3, 0x01 // add ebx, 1
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x80,
    ebx: 0x1122_3344,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x80);
  strictEqual(result.state.ebx, 0x1122_ff83);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block sign-extends a tracked partial MOV value", async () => {
  const bytes = [
    0x66, 0x89, 0xd8, // mov ax, bx
    0x0f, 0xbf, 0xc8 // movsx ecx, ax
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_0000,
    ebx: 0x0000_8001,
    ecx: 0xcccc_cccc,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_8001);
  strictEqual(result.state.ebx, 0x0000_8001);
  strictEqual(result.state.ecx, 0xffff_8001);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + bytes.length });
});

test("jit IR block emits movzx and movsx memory forms", async () => {
  const movzxByte = await runJitIrBlock(
    [0x0f, 0xb6, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xfe] }]
  );
  const movzxWord = await runJitIrBlock(
    [0x0f, 0xb7, 0x03],
    createCpuState({ eax: 0xffff_ffff, ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xff, 0x80] }]
  );
  const movsxByte = await runJitIrBlock(
    [0x0f, 0xbe, 0x03],
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0x80] }]
  );
  const movsxWord = await runJitIrBlock(
    [0x0f, 0xbf, 0x03],
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0x01, 0x80] }]
  );

  strictEqual(movzxByte.state.eax, 0xfe);
  strictEqual(movzxByte.state.eflags, preservedEflags);
  strictEqual(movzxByte.state.eip, startAddress + 3);
  strictEqual(movzxByte.state.instructionCount, 1);

  strictEqual(movzxWord.state.eax, 0x80ff);
  strictEqual(movzxWord.state.eflags, preservedEflags);
  strictEqual(movzxWord.state.eip, startAddress + 3);
  strictEqual(movzxWord.state.instructionCount, 1);

  strictEqual(movsxByte.state.eax, 0xffff_ff80);
  strictEqual(movsxByte.state.eflags, preservedEflags);
  strictEqual(movsxByte.state.eip, startAddress + 3);
  strictEqual(movsxByte.state.instructionCount, 1);

  strictEqual(movsxWord.state.eax, 0xffff_8001);
  strictEqual(movsxWord.state.eflags, preservedEflags);
  strictEqual(movsxWord.state.eip, startAddress + 3);
  strictEqual(movsxWord.state.instructionCount, 1);
});

test("jit IR block coalesces independent low-byte register writes correctly", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x05, // mov al, 5
    0xb4, 0x05 // mov ah, 5
  ], createCpuState({
    eax: 0x1122_3300,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1122_0505);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block materializes partial register writes before full-register copies", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x05, // mov al, 5
    0x89, 0xc3 // mov ebx, eax
  ], createCpuState({
    eax: 0x1122_3300,
    ebx: 0xcccc_cccc,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1122_3305);
  strictEqual(result.state.ebx, 0x1122_3305);
  strictEqual(result.state.eip, startAddress + 4);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block composes AX then AL through planned exit store sources", async () => {
  const instructionBytes = [
    [0x66, 0x89, 0xc8], // mov ax, cx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ];
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_0000,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_1256);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block composes EAX then AL without loading EAX from CPU state", async () => {
  const instructionBytes = [
    [0x89, 0xc8], // mov eax, ecx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ];
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xbbbb_1256);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block captures produced root exit stores without rematerializing the load", async () => {
  const instructionBytes = [
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0xcd, 0x2e] // int 0x2e
  ];
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0x1234_5678, 32) }]);

  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block composes EAX then AX without loading EAX from CPU state", async () => {
  const instructionBytes = [
    [0x89, 0xc8], // mov eax, ecx
    [0x66, 0x89, 0xd0], // mov ax, dx
    [0xcd, 0x2e] // int 0x2e
  ];
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xbbbb_5678);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block composes AX then AH through value-state writes", async () => {
  const result = await runJitIrBlock([
    0x66, 0x89, 0xc8, // mov ax, cx
    0x88, 0xd4, // mov ah, dl
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_0000,
    ecx: 0xbbbb_1234,
    edx: 0xcccc_cc56,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_5634);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block exit stores AL and AX immediates without full EAX loads", async () => {
  const alBytes = [[0xb0, 0x34], [0xcd, 0x2e]]; // mov al, 0x34; int 0x2e
  const axBytes = [[0x66, 0xb8, 0x34, 0x12], [0xcd, 0x2e]]; // mov ax, 0x1234; int 0x2e
  const alResult = await runJitIrBlock(alBytes.flat(), createCpuState({ eax: 0xaaaa_aa00, eip: startAddress }));
  const axResult = await runJitIrBlock(axBytes.flat(), createCpuState({ eax: 0xaaaa_0000, eip: startAddress }));

  strictEqual(alResult.state.eax, 0xaaaa_aa34);
  strictEqual(axResult.state.eax, 0xaaaa_1234);
  deepStrictEqual(alResult.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
  deepStrictEqual(axResult.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block keeps AX prefix semantics when a full read also occurs", async () => {
  const instructionBytes = [
    [0x66, 0xb8, 0x34, 0x12], // mov ax, 0x1234
    [0x89, 0xc3], // mov ebx, eax
    [0xcd, 0x2e] // int 0x2e
  ];
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 0xaaaa_0000,
    ebx: 0xbbbb_bbbb,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_1234);
  strictEqual(result.state.ebx, 0xaaaa_1234);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block reads known partial register prefixes across instructions", async () => {
  const result = await runJitIrBlock([
    0xb0, 0x78, // mov al, 0x78
    0x88, 0xc3, // mov bl, al
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aa00,
    ebx: 0xbbbb_bb00,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xaaaa_aa78);
  strictEqual(result.state.ebx, 0xbbbb_bb78);
  strictEqual(result.state.eip, startAddress + 6);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block preserves al, ax, and ah reads from tracked full registers", async () => {
  const al = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x88, 0xc3, // mov bl, al
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xaaaa_aa00,
    eip: startAddress
  }));
  const ax = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xaaaa_0000,
    eip: startAddress
  }));
  const ah = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0x88, 0xe3, // mov bl, ah
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0xbbbb_bb00,
    eip: startAddress
  }));

  strictEqual(al.state.eax, 0x1234_5678);
  strictEqual(al.state.ebx, 0xaaaa_aa78);
  strictEqual(al.state.eip, startAddress + 9);
  strictEqual(al.state.instructionCount, 3);
  deepStrictEqual(al.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(ax.state.eax, 0x1234_5678);
  strictEqual(ax.state.ebx, 0xaaaa_5678);
  strictEqual(ax.state.eip, startAddress + 10);
  strictEqual(ax.state.instructionCount, 3);
  deepStrictEqual(ax.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(ah.state.eax, 0x1234_5678);
  strictEqual(ah.state.ebx, 0xbbbb_bb56);
  strictEqual(ah.state.eip, startAddress + 9);
  strictEqual(ah.state.instructionCount, 3);
  deepStrictEqual(ah.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block preserves mixed al, ah, ax, and eax alias interactions", async () => {
  const alAhToAx = await runJitIrBlock([
    0xb0, 0x34, // mov al, 0x34
    0xb4, 0x12, // mov ah, 0x12
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));
  const axToAh = await runJitIrBlock([
    0x66, 0xb8, 0x34, 0x12, // mov ax, 0x1234
    0x88, 0xe3, // mov bl, ah
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));
  const alToAxPreservesAh = await runJitIrBlock([
    0xb0, 0x34, // mov al, 0x34
    0x66, 0x89, 0xc3, // mov bx, ax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_1200,
    ebx: 0,
    eip: startAddress
  }));
  const fullAfterPartial = await runJitIrBlock([
    0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
    0xb0, 0xaa, // mov al, 0xaa
    0x89, 0xc3, // mov ebx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    ebx: 0,
    eip: startAddress
  }));

  strictEqual(alAhToAx.state.eax, 0x1234);
  strictEqual(alAhToAx.state.ebx, 0x1234);
  strictEqual(alAhToAx.state.eip, startAddress + 9);
  strictEqual(alAhToAx.state.instructionCount, 4);
  deepStrictEqual(alAhToAx.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(axToAh.state.eax, 0x1234);
  strictEqual(axToAh.state.ebx, 0x12);
  strictEqual(axToAh.state.eip, startAddress + 8);
  strictEqual(axToAh.state.instructionCount, 3);
  deepStrictEqual(axToAh.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(alToAxPreservesAh.state.eax, 0xaaaa_1234);
  strictEqual(alToAxPreservesAh.state.ebx, 0x1234);
  strictEqual(alToAxPreservesAh.state.eip, startAddress + 7);
  strictEqual(alToAxPreservesAh.state.instructionCount, 3);
  deepStrictEqual(alToAxPreservesAh.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(fullAfterPartial.state.eax, 0x1234_56aa);
  strictEqual(fullAfterPartial.state.ebx, 0x1234_56aa);
  strictEqual(fullAfterPartial.state.eip, startAddress + 11);
  strictEqual(fullAfterPartial.state.instructionCount, 4);
  deepStrictEqual(fullAfterPartial.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block handles byte and word memory MOV accesses", async () => {
  const byteStore = await runJitIrBlock([0x88, 0x03], createCpuState({
    eax: 0xaabb_ccdd,
    ebx: 0x40,
    eip: startAddress
  }));
  const wordLoad = await runJitIrBlock(
    [0x66, 0x8b, 0x03],
    createCpuState({
      eax: 0xffff_0000,
      ebx: 0x40,
      eip: startAddress
    }),
    [{ address: 0x40, bytes: [0x34, 0x12] }]
  );
  const wordStore = await runJitIrBlock([0x66, 0x89, 0x03], createCpuState({
    eax: 0xaaaa_babe,
    ebx: 0x44,
    eip: startAddress
  }));

  strictEqual(byteStore.guestView.getUint8(0x40), 0xdd);
  strictEqual(wordLoad.state.eax, 0xffff_1234);
  strictEqual(wordStore.guestView.getUint16(0x44, true), 0xbabe);
  strictEqual(wordStore.guestView.getUint8(0x46), 0);
});

test("jit IR block handles partial-width ALU register writeback", async () => {
  const result = await runJitIrBlock([0x04, 0x01], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0xffff_ff00);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block keeps partial-width immediate ALU inside the destination alias", async () => {
  const cases = [
    {
      name: "ADD AX wraps at 16 bits",
      bytes: [0x66, 0x05, 0xff, 0xff],
      eax: 0xffff_0001,
      expectedEax: 0xffff_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "ADD AX does not carry into high EAX",
      bytes: [0x66, 0x05, 0x01, 0x00],
      eax: 0x1234_ffff,
      expectedEax: 0x1234_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "SUB AX does not borrow from high EAX",
      bytes: [0x66, 0x2d, 0x01, 0x00],
      eax: 0x1234_0000,
      expectedEax: 0x1234_ffff,
      expectedEflags: subBorrowEflags
    },
    {
      name: "ADD AL does not carry into high EAX",
      bytes: [0x04, 0x01],
      eax: 0xffff_00ff,
      expectedEax: 0xffff_0000,
      expectedEflags: addWraparoundEflags
    },
    {
      name: "SUB AL does not borrow from high EAX",
      bytes: [0x2c, 0x01],
      eax: 0xffff_0000,
      expectedEax: 0xffff_00ff,
      expectedEflags: subBorrowEflags
    }
  ] as const;

  for (const testCase of cases) {
    const result = await runJitIrBlock(testCase.bytes, createCpuState({
      eax: testCase.eax,
      eflags: preservedEflags,
      eip: startAddress
    }));

    strictEqual(result.state.eax, testCase.expectedEax, testCase.name);
    strictEqual(result.state.eflags, (preservedEflags | testCase.expectedEflags) >>> 0, testCase.name);
    strictEqual(result.state.eip, startAddress + testCase.bytes.length, testCase.name);
    strictEqual(result.state.instructionCount, 1, testCase.name);
  }
});

test("jit IR block emits NOT register and memory forms without changing flags", async () => {
  const initialEflags = (preservedEflags | allArithmeticEflags) >>> 0;
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    eax: number;
    expectedEax: number;
    memoryValue?: number;
    expectedMemoryValue?: number;
  }>[] = [
    {
      name: "NOT AL",
      bytes: [0xf6, 0xd0],
      width: 8,
      eax: 0x1234_560f,
      expectedEax: 0x1234_56f0
    },
    {
      name: "NOT AX",
      bytes: [0x66, 0xf7, 0xd0],
      width: 16,
      eax: 0x1234_560f,
      expectedEax: 0x1234_a9f0
    },
    {
      name: "NOT EAX",
      bytes: [0xf7, 0xd0],
      width: 32,
      eax: 0x1234_560f,
      expectedEax: 0xedcb_a9f0
    },
    {
      name: "NOT byte [EAX]",
      bytes: [0xf6, 0x10],
      width: 8,
      eax: 0x40,
      expectedEax: 0x40,
      memoryValue: 0x0f,
      expectedMemoryValue: 0xf0
    },
    {
      name: "NOT word [EAX]",
      bytes: [0x66, 0xf7, 0x10],
      width: 16,
      eax: 0x44,
      expectedEax: 0x44,
      memoryValue: 0x560f,
      expectedMemoryValue: 0xa9f0
    },
    {
      name: "NOT dword [EAX]",
      bytes: [0xf7, 0x10],
      width: 32,
      eax: 0x48,
      expectedEax: 0x48,
      memoryValue: 0x1234_560f,
      expectedMemoryValue: 0xedcb_a9f0
    }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      createCpuState({ eax: entry.eax, eflags: initialEflags, eip: startAddress }),
      entry.memoryValue === undefined
        ? []
        : [{ address: entry.eax, bytes: littleEndianBytes(entry.memoryValue, entry.width) }]
    );

    strictEqual(result.state.eax, entry.expectedEax, entry.name);
    strictEqual(result.state.eflags, initialEflags, entry.name);
    if (entry.expectedMemoryValue !== undefined) {
      strictEqual(readGuestValue(result.guestView, entry.eax, entry.width), entry.expectedMemoryValue, entry.name);
    }
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block emits NEG register flags for zero, one, min-signed, and wraparound cases", async () => {
  const zeroFlags = { CF: false, OF: false, SF: false, ZF: true, PF: true, AF: false };
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const min8Flags = { CF: true, OF: true, SF: true, ZF: false, PF: false, AF: false };
  const minWideFlags = { CF: true, OF: true, SF: true, ZF: false, PF: true, AF: false };
  const wrapFlags = { CF: true, OF: false, SF: false, ZF: false, PF: false, AF: true };
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    initialEax: number;
    expectedEax: number;
    flags: ArithmeticFlagExpectations;
  }>[] = [
    { name: "NEG AL zero", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa00, expectedEax: 0xaaaa_aa00, flags: zeroFlags },
    { name: "NEG AL one", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa01, expectedEax: 0xaaaa_aaff, flags: oneFlags },
    { name: "NEG AL min-signed", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aa80, expectedEax: 0xaaaa_aa80, flags: min8Flags },
    { name: "NEG AL wraparound", bytes: [0xf6, 0xd8], initialEax: 0xaaaa_aaff, expectedEax: 0xaaaa_aa01, flags: wrapFlags },
    { name: "NEG AX zero", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_0000, expectedEax: 0xaaaa_0000, flags: zeroFlags },
    { name: "NEG AX one", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_0001, expectedEax: 0xaaaa_ffff, flags: oneFlags },
    { name: "NEG AX min-signed", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_8000, expectedEax: 0xaaaa_8000, flags: minWideFlags },
    { name: "NEG AX wraparound", bytes: [0x66, 0xf7, 0xd8], initialEax: 0xaaaa_ffff, expectedEax: 0xaaaa_0001, flags: wrapFlags },
    { name: "NEG EAX zero", bytes: [0xf7, 0xd8], initialEax: 0, expectedEax: 0, flags: zeroFlags },
    { name: "NEG EAX one", bytes: [0xf7, 0xd8], initialEax: 1, expectedEax: 0xffff_ffff, flags: oneFlags },
    { name: "NEG EAX min-signed", bytes: [0xf7, 0xd8], initialEax: 0x8000_0000, expectedEax: 0x8000_0000, flags: minWideFlags },
    { name: "NEG EAX wraparound", bytes: [0xf7, 0xd8], initialEax: 0xffff_ffff, expectedEax: 1, flags: wrapFlags }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(entry.bytes, createCpuState({
      eax: entry.initialEax,
      eflags: (preservedEflags | allArithmeticEflags) >>> 0,
      eip: startAddress
    }));
    const expectedEflags = (preservedEflags | arithmeticEflags(entry.flags)) >>> 0;

    strictEqual(result.state.eax, entry.expectedEax, entry.name);
    strictEqual(result.state.eflags, expectedEflags, entry.name);
    assertArithmeticFlags(result.state, entry.flags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
  }
});

test("jit IR block emits NEG memory forms for byte, word, and dword operands", async () => {
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const cases: readonly Readonly<{
    name: string;
    bytes: readonly number[];
    width: 8 | 16 | 32;
    address: number;
    expectedMemoryValue: number;
  }>[] = [
    { name: "NEG byte [EAX]", bytes: [0xf6, 0x18], width: 8, address: 0x50, expectedMemoryValue: 0xff },
    { name: "NEG word [EAX]", bytes: [0x66, 0xf7, 0x18], width: 16, address: 0x54, expectedMemoryValue: 0xffff },
    { name: "NEG dword [EAX]", bytes: [0xf7, 0x18], width: 32, address: 0x58, expectedMemoryValue: 0xffff_ffff }
  ];

  for (const entry of cases) {
    const result = await runJitIrBlock(
      entry.bytes,
      createCpuState({
        eax: entry.address,
        eflags: (preservedEflags | allArithmeticEflags) >>> 0,
        eip: startAddress
      }),
      [{ address: entry.address, bytes: littleEndianBytes(1, entry.width) }]
    );

    strictEqual(result.state.eax, entry.address, entry.name);
    strictEqual(readGuestValue(result.guestView, entry.address, entry.width), entry.expectedMemoryValue, entry.name);
    strictEqual(result.state.eflags, (preservedEflags | arithmeticEflags(oneFlags)) >>> 0, entry.name);
    assertArithmeticFlags(result.state, oneFlags, entry.name);
    strictEqual(result.state.eip, startAddress + entry.bytes.length, entry.name);
    strictEqual(result.state.instructionCount, 1, entry.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + entry.bytes.length });
  }
});

test("jit IR block preserves unary ALU flags and memory effects with value timeline lowering", async () => {
  const oneFlags = { CF: true, OF: false, SF: true, ZF: false, PF: true, AF: true };
  const initialEflags = (preservedEflags | allArithmeticEflags) >>> 0;
  const foldedNeg = await runJitIrBlock([
    0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
    0xf7, 0xd8, // neg eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eflags: initialEflags,
    eip: startAddress
  }));
  const memoryNot = await runJitIrBlock([
    0xb8, 0x60, 0x00, 0x00, 0x00, // mov eax, 0x60
    0xf7, 0x10, // not dword [eax]
    0x8b, 0x18, // mov ebx, [eax]
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eflags: initialEflags,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0x1234_560f, 32) }]);

  strictEqual(foldedNeg.state.eax, 0xffff_ffff);
  strictEqual(foldedNeg.state.eflags, (preservedEflags | arithmeticEflags(oneFlags)) >>> 0);
  assertArithmeticFlags(foldedNeg.state, oneFlags, "folded NEG EAX");
  strictEqual(foldedNeg.state.instructionCount, 3);
  deepStrictEqual(foldedNeg.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });

  strictEqual(memoryNot.state.eax, 0x60);
  strictEqual(memoryNot.state.ebx, 0xedcb_a9f0);
  strictEqual(readGuestValue(memoryNot.guestView, 0x60, 32), 0xedcb_a9f0);
  strictEqual(memoryNot.state.eflags, initialEflags);
  strictEqual(memoryNot.state.instructionCount, 4);
  deepStrictEqual(memoryNot.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block shares planned cold AH xor result with narrow writeback", async () => {
  const bytes = [0x80, 0xf4, 0x05]; // xor ah, 5
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5378);
  strictEqual(result.state.eflags, (preservedEflags | 0x04) >>> 0);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block keeps cold AX xor writeback word-width", async () => {
  const bytes = [0x66, 0x35, 0x32, 0x04]; // xor ax, 0x432
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_524a);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block materializes a later full read after cold AH xor", async () => {
  const bytes = [
    0x80, 0xf4, 0x05, // xor ah, 5
    0x89, 0xc3 // mov ebx, eax
  ];
  const result = await runJitIrBlock(bytes, createCpuState({
    eax: 0x1234_5678,
    ebx: 0xaaaa_aaaa,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5378);
  strictEqual(result.state.ebx, 0x1234_5378);
  strictEqual(result.state.eflags, (preservedEflags | 0x04) >>> 0);
  strictEqual(result.state.eip, startAddress + bytes.length);
  strictEqual(result.state.instructionCount, 2);
});

test("jit IR block updates cmovcc destination when the condition passes", async () => {
  const taken = await runJitIrBlock(
    [0x0f, 0x44, 0xd1], // cmove edx, ecx
    createCpuState({
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x44, 0xd1], // cmove edx, ecx
    createCpuState({
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags,
      eip: startAddress
    })
  );

  strictEqual(taken.state.edx, 0x2222_2222);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.edx, 0x1111_1111);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block updates cmovcc r16 destination when the condition passes", async () => {
  const taken = await runJitIrBlock(
    [0x66, 0x0f, 0x44, 0xd1], // cmove dx, cx
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );
  const notTaken = await runJitIrBlock(
    [0x66, 0x0f, 0x44, 0xd1], // cmove dx, cx
    createCpuState({
      ecx: 0x3333_2222,
      edx: 0xaaaa_1111,
      eflags: preservedEflags,
      eip: startAddress
    })
  );

  strictEqual(taken.state.edx, 0xaaaa_2222);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.edx, 0xaaaa_1111);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block keeps cmovcc fallback value after previous high-byte write", async () => {
  const result = await runJitIrBlock(
    [
      0xb4, 0x22, // mov ah, 0x22
      0x0f, 0x45, 0xc1 // cmovne eax, ecx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ecx: 0x2222_2222,
      eflags: zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x1111_2211);
  strictEqual(result.state.ecx, 0x2222_2222);
  strictEqual(result.state.instructionCount, 2);
});

test("jit IR block keeps cmovcc source memory faults unconditional", async () => {
  const result = await runJitIrBlock(
    [0x0f, 0x45, 0x13], // cmovne edx, [ebx]
    createCpuState({
      ebx: 0x10000,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.edx, 0x1111_1111);
  strictEqual(result.state.eip, startAddress);
  strictEqual(result.state.instructionCount, 0);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block keeps cmovcc r16 source memory faults unconditional", async () => {
  const result = await runJitIrBlock(
    [0x66, 0x0f, 0x45, 0x13], // cmovne dx, [ebx]
    createCpuState({
      ebx: 0x10000,
      edx: 0xaaaa_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.edx, 0xaaaa_1111);
  strictEqual(result.state.eip, startAddress);
  strictEqual(result.state.instructionCount, 0);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 2 });
});

test("jit IR block emits setcc through a select value and normal write", async () => {
  const taken = await runJitIrBlock(
    [0x0f, 0x94, 0xc0], // sete al
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags | zeroFlag, eip: startAddress })
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x94, 0xc0], // sete al
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );
  const highByte = await runJitIrBlock(
    [0x0f, 0x95, 0xc4], // setne ah
    createCpuState({ eax: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );

  strictEqual(taken.state.eax, 0x1234_5601);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.state.eax, 0x1234_5600);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
  strictEqual(highByte.state.eax, 0x1234_0178);
  strictEqual(highByte.state.eflags, preservedEflags);
  strictEqual(highByte.state.instructionCount, 1);
});

test("jit IR block emits memory setcc as a selected byte store", async () => {
  const taken = await runJitIrBlock(
    [0x0f, 0x94, 0x03], // sete [ebx]
    createCpuState({ ebx: 0x20, eflags: preservedEflags | zeroFlag, eip: startAddress }),
    [{ address: 0x20, bytes: [0xaa] }]
  );
  const notTaken = await runJitIrBlock(
    [0x0f, 0x94, 0x03], // sete [ebx]
    createCpuState({ ebx: 0x20, eflags: preservedEflags, eip: startAddress }),
    [{ address: 0x20, bytes: [0xaa] }]
  );

  strictEqual(taken.guestView.getUint8(0x20), 1);
  strictEqual(taken.state.eflags, (preservedEflags | zeroFlag) >>> 0);
  strictEqual(taken.state.instructionCount, 1);
  strictEqual(notTaken.guestView.getUint8(0x20), 0);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.instructionCount, 1);
});

test("jit IR block lowers setcc conditions from local flag values", async () => {
  const equal = await runJitIrBlock(
    [
      0x39, 0xd8, // cmp eax, ebx
      0x0f, 0x94, 0xc0 // sete al
    ],
    createCpuState({ eax: 0x1234_5678, ebx: 0x1234_5678, eflags: preservedEflags, eip: startAddress })
  );
  const notEqual = await runJitIrBlock(
    [
      0x39, 0xd8, // cmp eax, ebx
      0x0f, 0x94, 0xc0 // sete al
    ],
    createCpuState({ eax: 0x1234_5678, ebx: 0x1234_5679, eflags: preservedEflags, eip: startAddress })
  );

  strictEqual(equal.state.eax, 0x1234_5601);
  strictEqual(equal.state.instructionCount, 2);
  strictEqual(notEqual.state.eax, 0x1234_5600);
  strictEqual(notEqual.state.instructionCount, 2);
});

test("jit IR block freezes cmovcc-selected register values before later full-register copies", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xc1, // cmove eax, ecx
      0x89, 0xc3, // mov ebx, eax
      0x0f, 0x44, 0xc2 // cmove eax, edx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ebx: 0xbbbb_bbbb,
      ecx: 0x2222_2222,
      edx: 0x3333_3333,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x3333_3333);
  strictEqual(result.state.ebx, 0x2222_2222);
  strictEqual(result.state.ecx, 0x2222_2222);
  strictEqual(result.state.edx, 0x3333_3333);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 8 });
});

test("jit IR block preserves cmovcc value-state writes on later pre-instruction exits", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xd1, // cmove edx, ecx
      0x8b, 0x03 // mov eax, [ebx]
    ],
    createCpuState({
      eax: 0xaaaa_aaaa,
      ebx: 0x10000,
      ecx: 0x2222_2222,
      edx: 0x1111_1111,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0xaaaa_aaaa);
  strictEqual(result.state.edx, 0x2222_2222);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block preserves a pre-instruction exit before later cmovcc mutation of the same register", async () => {
  const result = await runJitIrBlock(
    [
      0x0f, 0x44, 0xc1, // cmove eax, ecx
      0x8b, 0x16, // mov edx, [esi]
      0x0f, 0x44, 0xc3 // cmove eax, ebx
    ],
    createCpuState({
      eax: 0x1111_1111,
      ebx: 0x3333_3333,
      ecx: 0x2222_2222,
      edx: 0xdddd_dddd,
      esi: 0x10000,
      eflags: preservedEflags | zeroFlag,
      eip: startAddress
    })
  );

  strictEqual(result.state.eax, 0x2222_2222);
  strictEqual(result.state.ebx, 0x3333_3333);
  strictEqual(result.state.edx, 0xdddd_dddd);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block emits leave", async () => {
  const result = await runJitIrBlock(
    [0xc9],
    createCpuState({ ebp: 0x20, esp: 0x100, eip: startAddress }),
    [{ address: 0x20, bytes: [0x78, 0x56, 0x34, 0x12] }]
  );

  strictEqual(result.state.ebp, 0x1234_5678);
  strictEqual(result.state.esp, 0x24);
  strictEqual(result.state.eip, startAddress + 1);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block folds stack updates after successful memory fault points", async () => {
  const result = await runJitIrBlock([
    0x50, // push eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x1234_5678,
    esp: 0x24,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.guestView.getUint32(0x20, true), 0x1234_5678);
  strictEqual(result.state.esp, 0x20);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block keeps planned flag values live after memory-store fault branch emission", async () => {
  const result = await runJitIrBlock([
    0x01, 0x18, // add [eax], ebx
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0x20,
    ebx: 2,
    eip: startAddress
  }), [{ address: 0x20, bytes: [1, 0, 0, 0] }]);

  strictEqual(result.guestView.getUint32(0x20, true), 3);
  strictEqual(result.state.eflags, 0x04);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits add and materializes flag values", async () => {
  const result = await runJitIrBlock([0x83, 0xc0, 0x01], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block emits or and materializes logic flags", async () => {
  const result = await runJitIrBlock([0x0d, 0x00, 0x01, 0x00, 0x00], createCpuState({
    eax: 0x8000_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x8000_0100);
  strictEqual(result.state.eflags, (preservedEflags | 0x84) >>> 0);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block materializes the latest planned flag values on exit", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x83, 0xc0, 0x01, // add eax, 1
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 8);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block keeps mixed cached flag inputs stable after invalidation and recache", async () => {
  const instructionBytes = [
    [0x83, 0xc0, 0x01], // add eax, 1
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0x40], // inc eax (preserves CF, updates the other ALU flags)
    [0xcd, 0x2e] // int 0x2e
  ];
  const expectedFlags = {
    CF: false,
    OF: false,
    SF: false,
    ZF: true,
    PF: true,
    AF: true
  };
  const result = await runJitIrBlock(instructionBytes.flat(), createCpuState({
    eax: 1,
    eflags: (preservedEflags | allArithmeticEflags) >>> 0,
    eip: startAddress
  }), [{ address: 0x60, bytes: littleEndianBytes(0xffff_ffff, 32) }]);

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | arithmeticEflags(expectedFlags)) >>> 0);
  assertArithmeticFlags(result.state, expectedFlags, "cached flag input");
  strictEqual(result.state.eip, startAddress + 12);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block folds transient register value calculations", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0x01, 0xc3, // add ebx, eax
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 5,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 5);
  strictEqual(result.state.eip, startAddress + 14);
  strictEqual(result.state.instructionCount, 5);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes register values before memory fault exits", async () => {
  const load = 0x10000;
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8b, 0x15, 0x00, 0x00, 0x01, 0x00 // mov edx, [0x10000]
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0x1234_5678,
    edx: 0xeeee_eeee,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_5678);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.edx, 0xeeee_eeee);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: load, detail: 4 });
});

test("jit IR block preserves register values before source clobbers", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0xb9, 0x00, 0x00, 0x00, 0x00, // mov ecx, 0
    0x01, 0xc3, // add ebx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 7,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 7);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 0);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes repeated register value reads without changing results", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0x01, 0xc3, // add ebx, eax
    0x01, 0xc2, // add edx, eax
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 10,
    ecx: 5,
    edx: 20,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 7);
  strictEqual(result.state.ebx, 17);
  strictEqual(result.state.ecx, 5);
  strictEqual(result.state.edx, 27);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 5);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block lowers value timeline register state into indirect jump targets", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x83, 0xf0, 0x02, // xor eax, 2
    0xff, 0xe0 // jmp eax
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ecx: 0x1234_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_567a);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.eip, 0x1234_567a);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: 0x1234_567a });
});

test("jit IR block lowers value timeline register state into effective addresses", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8d, 0x58, 0x04, // lea ebx, [eax+4]
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0xbbbb_bbbb,
    ecx: 0x1234_5678,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 0x1234_567c);
  strictEqual(result.state.ecx, 0x1234_5678);
  strictEqual(result.state.eip, startAddress + 12);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block materializes register values for scaled effective addresses", async () => {
  const result = await runJitIrBlock([
    0x89, 0xc8, // mov eax, ecx
    0x8d, 0x1c, 0x45, 0x04, 0x00, 0x00, 0x00, // lea ebx, [eax*2+4]
    0xb8, 0x00, 0x00, 0x00, 0x00, // mov eax, 0
    0xcd, 0x2e // int 0x2e
  ], createCpuState({
    eax: 0xaaaa_aaaa,
    ebx: 0xbbbb_bbbb,
    ecx: 7,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.ebx, 18);
  strictEqual(result.state.ecx, 7);
  strictEqual(result.state.eip, startAddress + 16);
  strictEqual(result.state.instructionCount, 4);
  deepStrictEqual(result.exit, { exitReason: ExitReason.HOST_TRAP, payload: 0x2e });
});

test("jit IR block emits lea r16 without reading memory or modifying flags", async () => {
  const result = await runJitIrBlock([0x66, 0x8d, 0x44, 0xb3, 0x08], createCpuState({
    eax: 0x1234_0000,
    ebx: 0x100,
    esi: 3,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0x1234_0114);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 5);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block emits multi-byte nop without reading memory or modifying flags", async () => {
  const dword = await runJitIrBlock([0x0f, 0x1f, 0x40, 0x00], createCpuState({
    eax: 0x1_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const word = await runJitIrBlock([0x66, 0x0f, 0x1f, 0x00], createCpuState({
    eax: 0x1_0000,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(dword.state.eip, startAddress + 4);
  strictEqual(dword.state.eflags, preservedEflags);
  strictEqual(dword.state.instructionCount, 1);
  deepStrictEqual(dword.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });

  strictEqual(word.state.eip, startAddress + 4);
  strictEqual(word.state.eflags, preservedEflags);
  strictEqual(word.state.instructionCount, 1);
  deepStrictEqual(word.exit, { exitReason: ExitReason.FALLTHROUGH, payload: startAddress + 4 });
});

test("jit IR block preserves CF across INC partial flag writes", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, (preservedEflags | 0x01) >>> 0);
  strictEqual(result.state.eip, startAddress + 11);
  strictEqual(result.state.instructionCount, 3);
  deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 11 });
});

test("jit IR block branches on incoming CF after INC", async () => {
  const taken = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags | 0x01,
    eip: startAddress
  }));
  const notTaken = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(taken.state.eax, 1);
  strictEqual(taken.state.eflags, (preservedEflags | 0x01) >>> 0);
  strictEqual(taken.state.eip, startAddress + 8);
  strictEqual(taken.state.instructionCount, 2);
  deepStrictEqual(taken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 8 });

  strictEqual(notTaken.state.eax, 1);
  strictEqual(notTaken.state.eflags, preservedEflags);
  strictEqual(notTaken.state.eip, startAddress + 3);
  strictEqual(notTaken.state.instructionCount, 2);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 3 });
});

test("jit IR block keeps not-taken INC exit stores path-local after JC", async () => {
  const result = await runJitIrBlock([
    0x40, // inc eax
    0x72, 0x05 // jc +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(result.state.eflags, preservedEflags);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 3 });
});

test("jit IR block emits cmp without writing operands", async () => {
  const result = await runJitIrBlock([0x39, 0xd8], createCpuState({
    eax: 5,
    ebx: 5,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 5);
  strictEqual(result.state.ebx, 5);
  strictEqual(result.state.eflags, (preservedEflags | zeroResultEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 1);
});

test("jit IR block handles specialized cmp condition branches", async () => {
  const takenCases = [
    { name: "JE", opcode: 0x74, eax: 5, ebx: 5 },
    { name: "JNE", opcode: 0x75, eax: 5, ebx: 6 },
    { name: "JB", opcode: 0x72, eax: 1, ebx: 2 },
    { name: "JAE", opcode: 0x73, eax: 2, ebx: 1 },
    { name: "JL", opcode: 0x7c, eax: 0xffff_ffff, ebx: 1 },
    { name: "JGE", opcode: 0x7d, eax: 1, ebx: 0xffff_ffff },
    { name: "JLE", opcode: 0x7e, eax: 0xffff_ffff, ebx: 1 },
    { name: "JG", opcode: 0x7f, eax: 1, ebx: 0xffff_ffff }
  ] as const;

  for (const testCase of takenCases) {
    const result = await runJitIrBlock([
      0x39, 0xd8, // cmp eax, ebx
      testCase.opcode, 0x05
    ], createCpuState({
      eax: testCase.eax,
      ebx: testCase.ebx,
      eip: startAddress
    }));

    strictEqual(result.state.eip, startAddress + 9, testCase.name);
    strictEqual(result.state.instructionCount, 2, testCase.name);
    deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 9 });
  }
});

test("jit IR block materializes planned flag values before condition consumers", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 10);
  strictEqual(result.state.instructionCount, 2);
  deepStrictEqual(result.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 10 });
});

test("jit IR block materializes planned flag values on both conditional branch exits", async () => {
  const taken = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));
  const notTaken = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x74, 0x05 // jz +5
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(taken.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  deepStrictEqual(taken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 10 });
  strictEqual(notTaken.state.eflags, preservedEflags);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 5 });
});

test("jit IR block emits conditional branches", async () => {
  const taken = await runJitIrBlock([0x75, 0x05], createCpuState({
    eip: startAddress,
    instructionCount: 10
  }));
  const notTaken = await runJitIrBlock([0x75, 0x05], createCpuState({
    eip: startAddress,
    eflags: zeroFlag,
    instructionCount: 10
  }));

  deepStrictEqual(taken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 7 });
  strictEqual(taken.state.eip, startAddress + 7);
  strictEqual(taken.state.instructionCount, 11);
  deepStrictEqual(notTaken.exit, { exitReason: ExitReason.JUMP, payload: startAddress + 2 });
  strictEqual(notTaken.state.eip, startAddress + 2);
  strictEqual(notTaken.state.instructionCount, 11);
});

test("jit IR block materializes planned flag values on later fault exits", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00 // mov eax, [0x10000]
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block preserves incoming CF across INC on later fault exits", async () => {
  const result = await runJitIrBlock([
    0x40, // inc eax (preserves CF, updates the other ALU flags)
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00 // mov eax, [0x10000]
  ], createCpuState({
    eax: 0,
    eflags: preservedEflags | 0x01,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 1);
  strictEqual(getFlag(result.state, "CF"), true);
  strictEqual(result.state.eip, startAddress + 1);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});

test("jit IR block keeps flags live across memory fault exits before later overwrites", async () => {
  const result = await runJitIrBlock([
    0x83, 0xc0, 0x01, // add eax, 1
    0x8b, 0x05, 0x00, 0x00, 0x01, 0x00, // mov eax, [0x10000]
    0x83, 0xc0, 0x01 // add eax, 1
  ], createCpuState({
    eax: 0xffff_ffff,
    eflags: preservedEflags,
    eip: startAddress
  }));

  strictEqual(result.state.eax, 0);
  strictEqual(result.state.eflags, (preservedEflags | addWraparoundEflags) >>> 0);
  strictEqual(result.state.eip, startAddress + 3);
  strictEqual(result.state.instructionCount, 1);
  deepStrictEqual(result.exit, { exitReason: ExitReason.MEMORY_READ_FAULT, payload: 0x10000, detail: 4 });
});
