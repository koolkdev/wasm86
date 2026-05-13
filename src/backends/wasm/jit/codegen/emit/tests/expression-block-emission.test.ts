import {
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  WasmLocalScratchAllocator,
  wasmOpcode,
  wasmValueType,
  ExitReason,
  wasmBodyInstructions,
  wasmBodyOpcodes,
  emitJitBlock,
  buildJitInstructionValueTimeline,
  createJitIrState,
  const32,
  xorExpr,
  countOpcode,
  stateSnapshot,
} from "./value-local-store-test-helpers.js";
test("JIT emission consumes prebuilt expression blocks from instruction plans", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitIrState(body, [{ stores: [] }]);
  const entrySnapshot = stateSnapshot("preInstruction", 0x1000, 0);
  const postSnapshot = stateSnapshot("postInstruction", 0x1001, 1);
  const expressionBlock = [
    { op: "hostTrap", vector: xorExpr(const32(0x15), const32(0x3f)) }
  ] as const;

  emitJitBlock({
    body,
    scratch,
    state,
    exit: { exitLocal, exitLabelDepth: 0 },
    instructions: [{
      instructionId: "prebuilt-expression-block",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: "continue",
      entryPoint: {
        instructionIndex: 0,
        snapshot: entrySnapshot
      },
      postInstructionState: postSnapshot,
      exitPointCount: 1,
      operands: [],
      expressionBlock,
      valueTimeline: buildJitInstructionValueTimeline({
        operands: [],
        expressionBlock,
        entryValueState: entrySnapshot.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() }
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 0,
      exitReason: ExitReason.HOST_TRAP,
      snapshot: postSnapshot,
      exitMaterializationIndex: 0
    }]
  });
  scratch.assertClear();
  body.end();

  const encoded = body.encode();
  const instructions = wasmBodyInstructions(encoded);
  const vectorStoreIndex = instructions.findIndex((instruction, index) =>
    instruction.opcode === wasmOpcode.localSet &&
      instructions[index - 1]?.opcode === wasmOpcode.i32Xor
  );

  strictEqual(countOpcode(wasmBodyOpcodes(encoded), wasmOpcode.br), 1);
  strictEqual(vectorStoreIndex !== -1, true);

  const vectorLocal = instructions[vectorStoreIndex]?.local;
  const payloadExtendIndex = instructions.findIndex((instruction) =>
    instruction.opcode === wasmOpcode.i64ExtendI32U
  );
  const payloadGetIndex = instructions.findIndex((instruction, index) =>
    instruction.opcode === wasmOpcode.localGet &&
      instruction.local === vectorLocal &&
      index > vectorStoreIndex &&
      index < payloadExtendIndex
  );

  strictEqual(payloadExtendIndex > vectorStoreIndex, true);
  strictEqual(payloadGetIndex !== -1, true);
});
