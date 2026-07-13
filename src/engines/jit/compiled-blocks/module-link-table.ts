import { u32 } from "#core/numeric.js";

type JitModuleLinkTableOptions = Readonly<{
  targetEips: readonly number[];
}>;

export type JitLinkLayout = ReadonlyMap<number, number>;

export class JitModuleLinkTable {
  readonly table: WebAssembly.Table;
  readonly #slotsByTargetEip = new Map<number, number>();

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

      this.#slotsByTargetEip.set(targetEip, slot);
    }
  }

  installModuleLocalFallback(eip: number, fn: () => unknown): void {
    this.table.set(this.#slotForTarget(eip), fn);
  }

  targetEips(): readonly number[] {
    return [...this.#slotsByTargetEip.keys()];
  }

  linkLayout(): JitLinkLayout {
    return new Map(this.#slotsByTargetEip);
  }

  #slotForTarget(eip: number): number {
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
