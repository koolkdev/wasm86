import { decodeIsaBlock, type IsaDecodedBlock } from "#x86/isa/decoder/decode-block.js";
import type { IsaDecodeFault } from "#x86/isa/decoder/reader.js";
import { u32 } from "#x86/numeric.js";
import { UnsupportedWasmCodegenError } from "#backends/wasm/errors.js";
import { compileWasmBlockHandle, type WasmBlockHandle } from "#backends/wasm/jit/block-handle.js";
import type { WasmHostMemories } from "#backends/wasm/host/memories.js";
import type { CompiledBlockCache, CompiledBlockHandle, WasmCompiledBlockCodeMap } from "./block-cache.js";
import type { JitModuleLinkTable, JitLinkedBlockFunction } from "./module-link-table.js";

export type WasmCompiledBlockCacheLike = CompiledBlockCache & Partial<Readonly<{
  clear(): void;
  invalidate(startEip: number): void;
}>>;

export class CompiledBlockDecodeError extends Error {
  constructor(readonly fault: IsaDecodeFault) {
    super(`failed to decode compiled block at 0x${fault.address.toString(16)}`);
    this.name = "CompiledBlockDecodeError";
  }
}

export class WasmCompiledBlockCache implements WasmCompiledBlockCacheLike {
  readonly #blocksByEip = new Map<number, WasmBlockHandle>();
  readonly #dependentTablesByTargetEip = new Map<number, Set<JitModuleLinkTable>>();

  clear(): void {
    this.#blocksByEip.clear();
    this.#dependentTablesByTargetEip.clear();
  }

  getOrCompile(startEip: number, codeMap: WasmCompiledBlockCodeMap, memories: WasmHostMemories): CompiledBlockHandle | undefined {
    const blockKey = u32(startEip);
    const cached = this.#blocksByEip.get(blockKey);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const block = decodeIsaBlock(codeMap.createReader(memories.guest), blockKey, { maxInstructions: 1024 });

      assertCompiledBlockDecodable(block);

      if (block.instructions.length === 0) {
        return undefined;
      }

      const compiled = compileWasmBlockHandle([block], {
        stateMemory: memories.stateMemory,
        guestMemory: memories.guestMemory,
        blockKey
      });

      this.#blocksByEip.set(blockKey, compiled);
      this.#registerDependentTable(compiled);
      this.#installTargetInDependentTables(blockKey, compiled.exportedBlockFunctionForEip(blockKey));
      return compiled;
    } catch (error: unknown) {
      if (error instanceof UnsupportedWasmCodegenError) {
        return undefined;
      }

      throw error;
    }
  }

  invalidate(startEip: number): void {
    const blockKey = u32(startEip);
    const compiled = this.#blocksByEip.get(blockKey);

    if (compiled === undefined) {
      return;
    }

    this.#blocksByEip.delete(blockKey);
    this.#unregisterDependentTable(compiled.moduleLinkTable);

    const dependents = this.#dependentTablesByTargetEip.get(blockKey);

    if (dependents === undefined) {
      return;
    }

    for (const table of dependents) {
      table.invalidateTarget(blockKey);
    }
  }

  #registerDependentTable(compiled: WasmBlockHandle): void {
    const table = compiled.moduleLinkTable;

    if (table === undefined) {
      return;
    }

    for (const targetEip of table.targetEips()) {
      const dependents = dependentTablesForTarget(this.#dependentTablesByTargetEip, targetEip);

      dependents.add(table);

      const target = this.#blocksByEip.get(targetEip);

      if (target !== undefined) {
        table.installTarget(targetEip, target.exportedBlockFunctionForEip(targetEip));
      }
    }
  }

  #unregisterDependentTable(table: JitModuleLinkTable | undefined): void {
    if (table === undefined) {
      return;
    }

    for (const targetEip of table.targetEips()) {
      const dependents = this.#dependentTablesByTargetEip.get(targetEip);

      if (dependents === undefined) {
        continue;
      }

      dependents.delete(table);

      if (dependents.size === 0) {
        this.#dependentTablesByTargetEip.delete(targetEip);
      }
    }
  }

  #installTargetInDependentTables(targetEip: number, fn: JitLinkedBlockFunction): void {
    const dependents = this.#dependentTablesByTargetEip.get(targetEip);

    if (dependents === undefined) {
      return;
    }

    for (const table of dependents) {
      table.installTarget(targetEip, fn);
    }
  }
}

function dependentTablesForTarget(
  tablesByTargetEip: Map<number, Set<JitModuleLinkTable>>,
  eip: number
): Set<JitModuleLinkTable> {
  const targetEip = u32(eip);
  let dependents = tablesByTargetEip.get(targetEip);

  if (dependents === undefined) {
    dependents = new Set();
    tablesByTargetEip.set(targetEip, dependents);
  }

  return dependents;
}

function assertCompiledBlockDecodable(block: IsaDecodedBlock): void {
  if (block.terminator.kind === "decode-fault") {
    throw new CompiledBlockDecodeError(block.terminator.fault);
  }
}
