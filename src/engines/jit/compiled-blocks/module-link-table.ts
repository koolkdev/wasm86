import { u32 } from "#core/numeric.js";

export type JitLinkedBlockFunction = () => unknown;
export type JitModuleLocalFallbackFunction = JitLinkedBlockFunction;

export type JitModuleLinkTableOptions = Readonly<{
  targetEips: readonly number[];
}>;

type SlotEntry = {
  slot: number;
  fallback: JitModuleLocalFallbackFunction | undefined;
  installed: JitLinkedBlockFunction | undefined;
};

export class JitModuleLinkTable {
  readonly table: WebAssembly.Table;
  readonly #slotsByTargetEip = new Map<number, SlotEntry>();

  constructor(options: JitModuleLinkTableOptions) {
    const targetEips = uniqueTargetEips(options.targetEips);

    this.table = new WebAssembly.Table({
      element: "anyfunc",
      initial: targetEips.length,
      maximum: targetEips.length
    });

    for (let slot = 0; slot < targetEips.length; slot += 1) {
      const targetEip = targetEips[slot];

      if (targetEip === undefined) {
        throw new Error(`missing JIT link table target for slot ${slot}`);
      }

      this.#slotsByTargetEip.set(targetEip, {
        slot,
        fallback: undefined,
        installed: undefined
      });
    }
  }

  slotForTargetEip(eip: number): number {
    return this.#entryForTarget(eip).slot;
  }

  hasTargetEip(eip: number): boolean {
    return this.#slotsByTargetEip.has(u32(eip));
  }

  installModuleLocalFallback(eip: number, fn: JitModuleLocalFallbackFunction): void {
    const entry = this.#entryForTarget(eip);

    entry.fallback = fn;

    if (entry.installed === undefined) {
      this.table.set(entry.slot, fn);
    }
  }

  installTarget(eip: number, fn: JitLinkedBlockFunction): void {
    const entry = this.#entryForTarget(eip);

    entry.installed = fn;
    this.table.set(entry.slot, fn);
  }

  invalidateTarget(eip: number): void {
    const entry = this.#entryForTarget(eip);

    entry.installed = undefined;

    if (entry.fallback === undefined) {
      throw new Error(`cannot restore missing fallback for JIT link target 0x${u32(eip).toString(16)}`);
    }

    this.table.set(entry.slot, entry.fallback);
  }

  targetEips(): readonly number[] {
    return [...this.#slotsByTargetEip.keys()];
  }

  #entryForTarget(eip: number): SlotEntry {
    const targetEip = u32(eip);
    const existing = this.#slotsByTargetEip.get(targetEip);

    if (existing !== undefined) {
      return existing;
    }

    throw new Error(`unknown JIT link target for this module: 0x${targetEip.toString(16)}`);
  }
}

export function jitModuleLinkFallbackExportName(eip: number): string {
  return `stub_${u32(eip).toString(16)}`;
}

function uniqueTargetEips(targetEips: readonly number[]): readonly number[] {
  const unique: number[] = [];
  const seen = new Set<number>();

  for (const eip of targetEips) {
    const targetEip = u32(eip);

    if (!seen.has(targetEip)) {
      unique.push(targetEip);
      seen.add(targetEip);
    }
  }

  return unique;
}
