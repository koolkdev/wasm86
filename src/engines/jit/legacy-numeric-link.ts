import { assert } from "#common/assert.js";
import type {
  FunctionRef,
  TableRef
} from "#compiler/program/refs.js";
import type { LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import { u32 } from "#core/numeric.js";
import type { LinkCompletion } from "#wasm/emit/embed.js";
import type { JitLinkLayout } from "./compiled-blocks/module-link-table.js";

export type JitLink = Readonly<{
  targetEip: number;
  target:
    | Readonly<{ kind: "function"; function: FunctionRef }>
    | Readonly<{ kind: "table"; table: TableRef }>;
}>;

// Projects target-keyed JIT links into the numeric callbacks still consumed
// by emit/control.ts.
export class LegacyNumericLinkAdapter {
  readonly #linksByTargetEip = new Map<number, JitLink>();
  readonly #linkLayout: JitLinkLayout | undefined;

  constructor(
    links: readonly JitLink[],
    linkLayout: JitLinkLayout | undefined
  ) {
    this.#linkLayout = linkLayout;

    for (const link of links) {
      assert(!this.#linksByTargetEip.has(link.targetEip), `duplicate JIT link target: 0x${hex(link.targetEip)}`);
      this.#linksByTargetEip.set(link.targetEip, link);
    }
  }

  resolve(bindings: LegacyFunctionBindings): LinkCompletion {
    const tableLinks = [...this.#linksByTargetEip.values()].filter(
      (link): link is JitLink & Readonly<{
        target: Readonly<{ kind: "table"; table: TableRef }>;
      }> => link.target.kind === "table"
    );
    const completion: LinkCompletion = {
      kind: "link",
      functionFor: (targetEip) => {
        const link = this.#linksByTargetEip.get(u32(targetEip));

        if (link === undefined || link.target.kind !== "function") {
          return undefined;
        }

        const functionIndex = bindings.functions.get(link.target.function);

        assert(
          functionIndex !== undefined,
          `missing resolved function for JIT link target 0x${hex(link.targetEip)}`
        );
        return functionIndex;
      }
    };

    if (tableLinks.length === 0) {
      return completion;
    }

    const tableRef = tableLinks[0]?.target.table;

    assert(tableRef !== undefined, "missing declared JIT link table");
    assert(
      tableLinks.every((link) => link.target.table === tableRef),
      "one legacy JIT function cannot resolve multiple numeric link tables"
    );
    const typeIndex = bindings.typeIndex;
    const tableIndex = bindings.tables.get(tableRef);
    const linkLayout = this.#linkLayout;

    assert(tableIndex !== undefined, `missing resolved JIT link table ${tableRef.id}`);
    assert(linkLayout !== undefined, "missing slot layout for resolved JIT links");
    return {
      ...completion,
      table: {
        slotFor: (targetEip) => {
          const link = this.#linksByTargetEip.get(u32(targetEip));

          if (link?.target.kind !== "table") {
            return undefined;
          }

          const slot = linkLayout.get(link.targetEip);

          assert(slot !== undefined, `unknown numeric JIT link target: 0x${hex(link.targetEip)}`);
          return slot;
        },
        typeIndex,
        tableIndex
      }
    };
  }
}

function hex(value: number): string {
  return u32(value).toString(16);
}
