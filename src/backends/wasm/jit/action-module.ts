import { assert } from "#common/assert.js";
import type { ActionBlock } from "#ir/action/types.js";
import { u32 } from "#x86/numeric.js";
import { wasmGuestMemoryMinPages, wasmImport, wasmMemoryIndex } from "#wasm/abi.js";
import { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#wasm/encoder/module.js";
import { wasmValueType } from "#wasm/encoder/types.js";
import type { LinkCompletion } from "#wasm/emit/action/embed.js";
import { emitActionFunction } from "#wasm/emit/action/emit.js";
import { encodeExit, ExitReason } from "#wasm/exit.js";
import {
  jitModuleLinkFallbackExportName,
  type JitModuleLinkTable
} from "./compiled-blocks/module-link-table.js";

// Module assembly for action-pipeline JIT blocks: imported memories, one
// () -> i64 function per block exported under its entry eip, and a
// fallback stub per link-table target.

export type ActionJitBlock = Readonly<{
  entryEip: number;
  actions: ActionBlock;
}>;

export type EncodeActionJitModuleOptions = Readonly<{
  moduleLinkTable?: JitModuleLinkTable;
}>;

export function jitBlockExportName(eip: number): string {
  return `block_${u32(eip).toString(16)}`;
}

// The emitter's link arm walks the same continuations, so every external
// constant target it meets has a slot here.
export function actionJitModuleLinkTargets(blocks: readonly ActionJitBlock[]): readonly number[] {
  const internalEips = new Set(blocks.map((block) => u32(block.entryEip)));
  const targetEips: number[] = [];
  const seen = new Set<number>();

  for (const block of blocks) {
    for (const targetEip of constantContinuations(block.actions)) {
      if (!internalEips.has(targetEip) && !seen.has(targetEip)) {
        targetEips.push(targetEip);
        seen.add(targetEip);
      }
    }
  }

  return targetEips;
}

function constantContinuations(actions: ActionBlock): readonly number[] {
  const targets: number[] = [];

  for (const region of actions.regions) {
    const target = region.continuation === undefined
      ? undefined
      : actions.values.constValue(region.continuation);

    if (target !== undefined) {
      targets.push(u32(target));
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
  const stateMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.stateMemoryName, { minPages: 1 });
  const guestMemoryIndex = module.importMemory(wasmImport.moduleName, wasmImport.guestMemoryName, {
    minPages: wasmGuestMemoryMinPages
  });

  assert(
    stateMemoryIndex === wasmMemoryIndex.state && guestMemoryIndex === wasmMemoryIndex.guest,
    "unexpected Wasm memory import order"
  );

  const tableTargetEips = options.moduleLinkTable?.targetEips() ?? [];
  const tableIndex = tableTargetEips.length === 0
    ? undefined
    : module.importTable(wasmImport.moduleName, wasmImport.linkTableName, {
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

  const blockFunctionIndices = new Map<number, number>();

  for (const block of blocks) {
    const entryEip = u32(block.entryEip);

    assert(
      !blockFunctionIndices.has(entryEip),
      `duplicate JIT block module entry EIP: 0x${entryEip.toString(16)}`
    );
    blockFunctionIndices.set(entryEip, tableTargetEips.length + blockFunctionIndices.size);
  }

  const completion = linkCompletion(blockFunctionIndices, options.moduleLinkTable, typeIndex, tableIndex);

  for (const block of blocks) {
    const body = emitActionFunction(block.actions, {
      body: new WasmFunctionBodyEncoder(),
      embedding: { completion }
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
