import {
  deepStrictEqual,
  strictEqual,
  test,
  ok,
  decodeBytes,
  stateOffset,
  wasmMemoryIndex,
  wasmOpcode,
  buildBlock,
  encodeJitBlock,
  startAddress,
  decodedBlock,
  singleInstructionBodyOpcodes,
  jitBlockBodyOpcodes,
  assertNoMaskImmediatelyAfter,
  assertNoOperandMaskBefore,
  countOpcode,
  aluFlagMemoryAccessCounts,
  stateMemoryLoads,
  registerStateMemoryAccesses,
  memoryAccesses,
  extractOnlyFunctionBody,
} from "./block-test-helpers.js";
test("buildBlock does not specialize incoming CF after INC", () => {
  const inc = ok(decodeBytes([0x40], startAddress));
  const jc = ok(decodeBytes([0x72, 0x05], inc.nextEip));
  const block = buildBlock([inc, jc]);

  deepStrictEqual(aluFlagMemoryAccessCounts(block), { loads: 2, stores: 2 });
});

test("jit IR block emits aluFlags memory traffic only for flag reads and observable exits", () => {
  const flagFreeBlock = buildBlock([
    ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress)),
    ok(decodeBytes([0xbb, 0x02, 0x00, 0x00, 0x00], startAddress + 5)),
    ok(decodeBytes([0xcd, 0x2e], startAddress + 10))
  ]);
  const branchBlock = buildBlock([ok(decodeBytes([0x74, 0x05], startAddress))]);
  const add = ok(decodeBytes([0x83, 0xc0, 0x01], startAddress));
  const jnzAfterAdd = ok(decodeBytes([0x75, 0x05], add.nextEip));
  const branchAfterAddBlock = buildBlock([add, jnzAfterAdd]);
  const addTrapBlock = buildBlock([add, ok(decodeBytes([0xcd, 0x2e], add.nextEip))]);
  const inc = ok(decodeBytes([0x40], startAddress));
  const incTrapBlock = buildBlock([inc, ok(decodeBytes([0xcd, 0x2e], inc.nextEip))]);
  const orAfterInc = ok(decodeBytes([0x09, 0xd8], inc.nextEip));
  const fullOverwriteAfterIncBlock = buildBlock([
    inc,
    orAfterInc,
    ok(decodeBytes([0xcd, 0x2e], orAfterInc.nextEip))
  ]);

  deepStrictEqual(aluFlagMemoryAccessCounts(flagFreeBlock), { loads: 0, stores: 0 });
  deepStrictEqual(aluFlagMemoryAccessCounts(branchBlock), { loads: 1, stores: 0 });
  deepStrictEqual(stateMemoryLoads(branchBlock).slice(0, 2), [
    stateOffset.instructionCount,
    stateOffset.aluFlags
  ]);
  deepStrictEqual(aluFlagMemoryAccessCounts(branchAfterAddBlock), { loads: 0, stores: 2 });
  deepStrictEqual(aluFlagMemoryAccessCounts(addTrapBlock), { loads: 0, stores: 1 });
  deepStrictEqual(aluFlagMemoryAccessCounts(incTrapBlock), { loads: 1, stores: 1 });
  deepStrictEqual(aluFlagMemoryAccessCounts(fullOverwriteAfterIncBlock), { loads: 0, stores: 1 });
});

test("jit IR block omits redundant masks after byte and word memory loads", () => {
  const movAxOpcodes = singleInstructionBodyOpcodes([0x66, 0x8b, 0x03]);
  const movAlOpcodes = singleInstructionBodyOpcodes([0x8a, 0x03]);

  assertNoMaskImmediatelyAfter(movAxOpcodes, wasmOpcode.i32Load16U);
  assertNoMaskImmediatelyAfter(movAlOpcodes, wasmOpcode.i32Load8U);
});

test("jit IR block emits MOVSX with signed loads or sign-extension opcodes", () => {
  const movsxByteMem = singleInstructionBodyOpcodes([0x0f, 0xbe, 0x03]);
  const movsxWordMem = singleInstructionBodyOpcodes([0x0f, 0xbf, 0x03]);
  const movsxEbxAlBlock = buildBlock([ok(decodeBytes([0x0f, 0xbe, 0xd8], startAddress))]);
  const movsxEbxAl = jitBlockBodyOpcodes(movsxEbxAlBlock);
  const movsxAfterTrackedRegBlock = buildBlock([
    ok(decodeBytes([0x66, 0x89, 0xd8], startAddress)), // mov ax, bx
    ok(decodeBytes([0x0f, 0xbf, 0xc8], startAddress + 3)) // movsx ecx, ax
  ]);
  const movsxAfterTrackedReg = jitBlockBodyOpcodes(movsxAfterTrackedRegBlock);

  strictEqual(movsxByteMem.includes(wasmOpcode.i32Load8S), true);
  strictEqual(movsxByteMem.includes(wasmOpcode.i32Extend8S), false);
  strictEqual(movsxByteMem.includes(wasmOpcode.i32Xor), false);

  strictEqual(movsxWordMem.includes(wasmOpcode.i32Load16S), true);
  strictEqual(movsxWordMem.includes(wasmOpcode.i32Extend16S), false);
  strictEqual(movsxWordMem.includes(wasmOpcode.i32Xor), false);

  strictEqual(
    registerStateMemoryAccesses(movsxEbxAlBlock, stateOffset.eax)
      .some((access) => access.opcode === wasmOpcode.i32Load8S),
    true
  );
  strictEqual(movsxEbxAl.includes(wasmOpcode.i32Extend8S), false);
  strictEqual(movsxEbxAl.includes(wasmOpcode.i32Xor), false);

  strictEqual(movsxAfterTrackedReg.includes(wasmOpcode.i32Extend16S), false);
  strictEqual(
    registerStateMemoryAccesses(movsxAfterTrackedRegBlock, stateOffset.ebx).some(
      (access) => access.opcode === wasmOpcode.i32Load16S
    ),
    true
  );
  strictEqual(movsxAfterTrackedReg.includes(wasmOpcode.i32Xor), false);
});

test("jit IR block keeps MOVZX on unsigned loads without redundant masks", () => {
  const movzxBlBlock = buildBlock([ok(decodeBytes([0x0f, 0xb6, 0xc3], startAddress))]);
  const movzxBl = jitBlockBodyOpcodes(movzxBlBlock);
  const movzxWordMem = singleInstructionBodyOpcodes([0x0f, 0xb7, 0x03]);

  strictEqual(
    registerStateMemoryAccesses(movzxBlBlock, stateOffset.ebx)
      .some((access) => access.opcode === wasmOpcode.i32Load8U),
    true
  );
  strictEqual(movzxBl.includes(wasmOpcode.i32Load8S), false);
  assertNoMaskImmediatelyAfter(movzxBl, wasmOpcode.i32Load8U);

  strictEqual(movzxWordMem.includes(wasmOpcode.i32Load16U), true);
  strictEqual(movzxWordMem.includes(wasmOpcode.i32Load16S), false);
  assertNoMaskImmediatelyAfter(movzxWordMem, wasmOpcode.i32Load16U);
});

test("jit IR block omits narrow bitwise operand masks", () => {
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x35, 0x32, 0x04]), wasmOpcode.i32Xor);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x34, 0x12]), wasmOpcode.i32Xor);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x0d, 0x32, 0x04]), wasmOpcode.i32Or);
});

test("jit IR block omits redundant masks before input-state narrow add and sub loads", () => {
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x05, 0x01, 0x00]), wasmOpcode.i32Add);
  assertNoOperandMaskBefore(singleInstructionBodyOpcodes([0x66, 0x2d, 0x01, 0x00]), wasmOpcode.i32Sub);
});

test("jit IR block keeps mixed partial-register bitwise mask count within budget", () => {
  const movAh = ok(decodeBytes([0xb4, 0x07], startAddress));
  const movEbxEax = ok(decodeBytes([0x89, 0xc3], movAh.nextEip));
  const xorAx = ok(decodeBytes([0x66, 0x35, 0x32, 0x04], movEbxEax.nextEip));
  const opcodes = jitBlockBodyOpcodes(buildBlock([movAh, movEbxEax, xorAx]));

  // This is an explicit code-shape budget for mixed partial-register bitwise lowering.
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And) <= 11, true);
});

test("jit IR block uses full-register load/store for composed AX then AL exit stores", () => {
  const block = decodedBlock([
    [0x66, 0x89, 0xc8], // mov ax, cx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ]);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block stores composed EAX then AL exits without loading EAX", () => {
  const block = decodedBlock([
    [0x89, 0xc8], // mov eax, ecx
    [0x88, 0xd0], // mov al, dl
    [0xcd, 0x2e] // int 0x2e
  ]);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block emits one guest load when a load-result load feeds an exit store", () => {
  const block = decodedBlock([
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0xcd, 0x2e] // int 0x2e
  ]);
  const guestLoads = memoryAccesses(extractOnlyFunctionBody(encodeJitBlock([block])))
    .filter((access) => access.memoryIndex === wasmMemoryIndex.guest && access.opcode === wasmOpcode.i32Load);

  strictEqual(guestLoads.length, 1);
});

test("jit IR block stores composed EAX then AX exits without loading EAX", () => {
  const block = decodedBlock([
    [0x89, 0xc8], // mov eax, ecx
    [0x66, 0x89, 0xd0], // mov ax, dx
    [0xcd, 0x2e] // int 0x2e
  ]);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
  ]);
});

test("jit IR block uses narrow stores for AL and AX immediate exit stores", () => {
  const alBlock = decodedBlock([[0xb0, 0x34], [0xcd, 0x2e]]); // mov al, 0x34; int 0x2e
  const axBlock = decodedBlock([[0x66, 0xb8, 0x34, 0x12], [0xcd, 0x2e]]); // mov ax, 0x1234; int 0x2e

  deepStrictEqual(registerStateMemoryAccesses(alBlock, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store8, offset: stateOffset.eax }
  ]);
  deepStrictEqual(registerStateMemoryAccesses(axBlock, stateOffset.eax), [
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
});

test("jit IR block uses full-register load and word store when AX also feeds a full read", () => {
  const block = decodedBlock([
    [0x66, 0xb8, 0x34, 0x12], // mov ax, 0x1234
    [0x89, 0xc3], // mov ebx, eax
    [0xcd, 0x2e] // int 0x2e
  ]);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
});

test("jit IR block shares input-state AH xor result between flags and byte writeback", () => {
  const block = buildBlock([ok(decodeBytes([0x80, 0xf4, 0x05], startAddress))]); // xor ah, 5
  const opcodes = jitBlockBodyOpcodes(block);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load8U, offset: stateOffset.eax + 1 },
    { opcode: wasmOpcode.i32Store8, offset: stateOffset.eax + 1 }
  ]);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 0);
});

test("jit IR block shares input-state AX xor result between flags and word writeback", () => {
  const block = buildBlock([ok(decodeBytes([0x66, 0x35, 0x32, 0x04], startAddress))]); // xor ax, 0x432
  const opcodes = jitBlockBodyOpcodes(block);

  deepStrictEqual(registerStateMemoryAccesses(block, stateOffset.eax), [
    { opcode: wasmOpcode.i32Load16U, offset: stateOffset.eax },
    { opcode: wasmOpcode.i32Store16, offset: stateOffset.eax }
  ]);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 0);
});

test("jit IR block emits one guest load for mixed cached flag inputs", () => {
  const block = decodedBlock([
    [0x83, 0xc0, 0x01], // add eax, 1
    [0x8b, 0x05, 0x60, 0x00, 0x00, 0x00], // mov eax, [0x60]
    [0x40], // inc eax
    [0xcd, 0x2e] // int 0x2e
  ]);
  const guestLoads = memoryAccesses(extractOnlyFunctionBody(encodeJitBlock([block])))
    .filter((access) => access.memoryIndex === wasmMemoryIndex.guest && access.opcode === wasmOpcode.i32Load);

  strictEqual(guestLoads.length, 1);
});

test("jit IR block emits setcc through a select opcode", () => {
  const instruction = ok(decodeBytes([0x0f, 0x94, 0xc0], startAddress));
  const opcodes = jitBlockBodyOpcodes(buildBlock([instruction]));

  strictEqual(opcodes.includes(wasmOpcode.select), true);
});

test("jit IR block emits cmovcc through a select opcode", () => {
  const instruction = ok(decodeBytes([0x0f, 0x44, 0xd1], startAddress));
  const block = buildBlock([instruction]);
  const opcodes = jitBlockBodyOpcodes(block);

  strictEqual(opcodes.includes(wasmOpcode.select), true);
});
