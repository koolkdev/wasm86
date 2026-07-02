import { assert } from "#common/assert.js";
import type { IrBlock } from "#ir/block.js";
import { u32 } from "#x86/numeric.js";
import { wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import type { LinkCompletion } from "#wasm/emit/embed.js";
import { emitActionFunction } from "#wasm/emit/emit.js";
import {
  analyzeBlockValues,
  type BlockValueAnalysis
} from "#wasm/emit/values.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import {
  createWasmHelperRegistry,
  defineRequiredHelpers,
  helperCallsForBlock
} from "#wasm/helpers/module.js";
import {
  jitModuleLinkFallbackExportName,
  type JitModuleLinkTable
} from "./compiled-blocks/module-link-table.js";

// Module assembly for action-pipeline JIT blocks: imported memories, one
// () -> i64 function per block exported under its entry eip, and a
// fallback stub per link-table target.

export type ActionJitBlock = Readonly<{
  entryEip: number;
  actions: IrBlock;
}>;

type AnalyzedActionJitBlock = Readonly<{
  entryEip: number;
  actions: IrBlock;
  analysis: BlockValueAnalysis;
}>;

export type EncodeActionJitModuleOptions = Readonly<{
  moduleLinkTable?: JitModuleLinkTable;
}>;

export function jitBlockExportName(eip: number): string {
  return `block_${u32(eip).toString(16)}`;
}

// The emitter's link arm walks the same dispatch targets, so every external
// constant target it meets has a slot here.
export function actionJitModuleLinkTargets(blocks: readonly ActionJitBlock[]): readonly number[] {
  const internalEips = new Set(blocks.map((block) => u32(block.entryEip)));
  const targetEips: number[] = [];
  const seen = new Set<number>();

  for (const block of blocks) {
    for (const targetEip of constantDispatchTargets(block.actions)) {
      if (!internalEips.has(targetEip) && !seen.has(targetEip)) {
        targetEips.push(targetEip);
        seen.add(targetEip);
      }
    }
  }

  return targetEips;
}

function constantDispatchTargets(actions: IrBlock): readonly number[] {
  const targets: number[] = [];

  for (const region of actions.regions) {
    switch (region.kind) {
      case "entry":
        for (const action of region.actions) {
          if (action.kind === "finish" && action.finish.kind === "dispatch") {
            const target = actions.values.constValue(action.finish.targetEip);

            if (target !== undefined) {
              targets.push(u32(target));
            }
          }
        }

        break;
      case "edge":
        if (region.terminator.kind === "dispatch") {
          const target = actions.values.constValue(region.terminator.targetEip);

          if (target !== undefined) {
            targets.push(u32(target));
          }
        }

        break;
    }
  }

  return targets;
}

export function encodeActionJitModule(
  blocks: readonly ActionJitBlock[],
  options: EncodeActionJitModuleOptions = {}
): Uint8Array<ArrayBuffer> {
  assert(blocks.length > 0, "cannot encode an empty JIT block module");

  const module = new WasmModuleEncoder();
  const cpuStateMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.cpuStateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.namespace, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    cpuStateMemoryIndex === wasmMemoryIndex.cpuState && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const tableTargetEips = options.moduleLinkTable?.targetEips() ?? [];
  const tableIndex = tableTargetEips.length === 0
    ? undefined
    : module.importTable(wasmImport.namespace, wasmImport.linkTableName, {
        minElements: tableTargetEips.length,
        maxElements: tableTargetEips.length
      });
  const typeIndex = module.addFunctionType({
    params: [],
    results: [wasmValueType.i64]
  });

  // Stubs go first; block function indices follow them.
  for (const targetEip of tableTargetEips) {
    const stubIndex = module.addFunction(
      typeIndex,
      new WasmFunctionBodyEncoder().i64Const(encodeExit(ExitReason.LINK_STUB, targetEip)).end()
    );

    module.exportFunction(jitModuleLinkFallbackExportName(targetEip), stubIndex);
  }

  const analyzedBlocks = blocks.map((block): AnalyzedActionJitBlock => ({
    ...block,
    analysis: analyzeBlockValues(block.actions)
  }));
  const helpers = createWasmHelperRegistry(module);
  const helperCalls = analyzedBlocks.flatMap((block) =>
    helperCallsForBlock(block.actions, block.analysis)
  );

  defineRequiredHelpers(helpers, helperCalls);

  const blockFunctionIndices = new Map<number, number>();
  const functionIndexBase = tableTargetEips.length + helpers.helpers().length;

  for (const block of analyzedBlocks) {
    const entryEip = u32(block.entryEip);

    assert(
      !blockFunctionIndices.has(entryEip),
      `duplicate JIT block module entry EIP: 0x${entryEip.toString(16)}`
    );
    blockFunctionIndices.set(entryEip, functionIndexBase + blockFunctionIndices.size);
  }

  const completion = linkCompletion(blockFunctionIndices, options.moduleLinkTable, typeIndex, tableIndex);

  for (const block of analyzedBlocks) {
    const body = emitActionFunction(block.actions, {
      body: new WasmFunctionBodyEncoder(),
      helpers,
      analysis: block.analysis,
      embedding: { dispatch: completion }
    });
    const functionIndex = module.addFunction(typeIndex, body);

    assert(
      functionIndex === blockFunctionIndices.get(u32(block.entryEip)),
      `unexpected JIT block function index: ${functionIndex}`
    );
    module.exportFunction(jitBlockExportName(block.entryEip), functionIndex);
  }

  return module.encode();
}

function linkCompletion(
  blockFunctionIndices: ReadonlyMap<number, number>,
  moduleLinkTable: JitModuleLinkTable | undefined,
  typeIndex: number,
  tableIndex: number | undefined
): LinkCompletion {
  return {
    kind: "link",
    functionFor: (targetEip) => blockFunctionIndices.get(u32(targetEip)),
    ...(moduleLinkTable === undefined || tableIndex === undefined
      ? {}
      : {
          table: {
            slotFor: (targetEip) =>
              moduleLinkTable.hasTargetEip(targetEip)
                ? moduleLinkTable.slotForTargetEip(targetEip)
                : undefined,
            typeIndex,
            tableIndex
          }
        })
  };
}
