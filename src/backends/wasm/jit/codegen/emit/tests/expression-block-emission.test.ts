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
  boundaryState,
  const32,
  xorExpr,
  countOpcode,
  instructionEntry,
  instructionExit,
} from "./value-local-store-test-helpers.js";
import { rootValuePathScope } from "#backends/wasm/jit/codegen/plan/control-paths.js";
test("JIT emission consumes prebuilt expression blocks from instruction plans", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const exitLocal = body.addLocal(wasmValueType.i64);
  const state = createJitIrState(body, [{ stores: [] }]);
  const expressionBlock = [
    { op: "hostTrap", vector: xorExpr(const32(0x15), const32(0x3f)) }
  ] as const;
  const instruction = {
    instructionId: "prebuilt-expression-block",
    eip: 0x1000,
    nextEip: 0x1001,
    nextMode: "continue",
    operands: [],
    ir: expressionBlock
  } as const;
  const entrySnapshot = boundaryState(instructionEntry(0), 0);
  const postSnapshot = boundaryState(instructionExit(0, instruction), 1);

  emitJitBlock({
    body,
    scratch,
    state,
    exit: { exitLocal, exitLabelDepth: 0 },
    instructions: [{
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      entryPoint: {
        instructionIndex: 0,
        boundaryState: entrySnapshot
      },
      postInstructionState: postSnapshot,
      controlPathScopes: new Map(),
      exitPointCount: 1,
      operands: instruction.operands,
      expressionBlock,
      valueTimeline: buildJitInstructionValueTimeline({
        operands: [],
        expressionBlock,
        entryValueState: entrySnapshot.valueState
      }),
      sourceExpressionMap: { placementsBySourceOpIndex: new Map() },
      expressionPathScopes: new Map(),
      producedValuesByVarId: new Map(),
      plannedValueCapturesByExpressionIndex: new Map()
    }],
    exitPoints: [{
      instructionIndex: 0,
      opIndex: 0,
      emitBoundary: instructionEntry(0),
      observedBoundary: postSnapshot.boundary,
      observedState: postSnapshot,
      visibleEip: { kind: "static", value: instruction.nextEip },
      exitReason: ExitReason.HOST_TRAP,
      payload: { kind: "runtime", source: "hostTrapVector" },
      pathScope: rootValuePathScope(),
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
