import { assert } from "#common/assert.js";
import type { StorageAccess, StorageEffects } from "#compiler/function/storage.js";
import {
  blockId,
  siteId,
  siteIndexedOf,
  valueIndexedOf,
  type BlockId,
  type BlockInfo,
  type BodyEvent,
  type SiteId,
  type SiteRecord,
  type ValueDemand,
  type WasmBody,
  type WriteSite
} from "#compiler/wasm/function/body.js";
import type { WasmValueFacts } from "#compiler/wasm/function/values/facts.js";
import type { WasmValueGraph } from "#compiler/wasm/function/values/graph.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

type BlockDraft = {
  readonly parent: BlockId | undefined;
  readonly ownerSite: SiteId | undefined;
  readonly depth: number;
  readonly loopDepth: number;
  readonly isLoop: boolean;
  readonly armIndex: number;
  readonly sites: SiteId[];
  closeSite: SiteId | undefined;
  completes: boolean | undefined;
};

const noReads: readonly StorageAccess[] = [];

// Owns the dense target tables while one function traversal fills them. Its
// mutable shapes never escape; finish publishes the same storage as WasmBody.
export class WasmBodyBuilder {
  readonly #sites: SiteRecord[] = [];
  readonly #events: (BodyEvent | undefined)[] = [];
  readonly #blocks: BlockDraft[] = [];
  readonly #siteReads: (readonly StorageAccess[])[] = [];
  readonly #siteHasWrites: number[] = [];
  readonly #writeSites: WriteSite[] = [];
  readonly #producers: (SiteId | undefined)[] = [];
  readonly #joinProducers: (SiteId | undefined)[] = [];
  readonly #joinDependencies: (readonly ValueDemand[] | undefined)[] = [];
  readonly #operationSites: SiteId[] = [];

  finish(parameterCount: number, values: WasmValueGraph, facts: WasmValueFacts): WasmBody {
    const siteCount = this.#sites.length;
    const valueCount = values.length;

    for (const block of this.#blocks) {
      assert(block.closeSite !== undefined, "lowered block has no close site");
      assert(block.completes !== undefined, "lowered block has no completion decision");
    }
    return {
      parameterCount,
      values,
      facts,
      sites: siteIndexedOf(siteCount, this.#sites),
      events: siteIndexedOf(siteCount, this.#events as BodyEvent[]),
      blocks: this.#blocks as readonly BlockInfo[],
      siteReads: siteIndexedOf(siteCount, this.#siteReads),
      siteHasWrites: Uint8Array.from(this.#siteHasWrites),
      writeSites: this.#writeSites,
      producers: valueIndexedOf(valueCount, this.#producers),
      joinProducers: valueIndexedOf(valueCount, this.#joinProducers),
      joinDependencies: valueIndexedOf(valueCount, this.#joinDependencies),
      operationSites: this.#operationSites
    };
  }

  addSite(block: BlockId, nodeIndex: number, effects?: StorageEffects): SiteId {
    const site = siteId(this.#sites.length);

    this.#sites.push({ block, nodeIndex });
    this.#events.push(undefined);
    this.#siteReads.push(noReads);
    this.#siteHasWrites.push(0);
    this.#block(block).sites.push(site);
    if (effects !== undefined) {
      this.#recordEffects(site, effects);
    }
    return site;
  }

  writeEvent(site: SiteId, event: BodyEvent): void {
    this.#events[site] = event;
  }

  recordOperationSite(site: SiteId): void {
    this.#operationSites.push(site);
  }

  openBlock(
    parent: BlockId | undefined,
    ownerSite: SiteId | undefined,
    armIndex: number,
    isLoop: boolean,
    loopDepth: number
  ): BlockId {
    const block = blockId(this.#blocks.length);

    this.#blocks.push({
      parent,
      ownerSite,
      depth: parent === undefined ? 0 : this.#block(parent).depth + 1,
      loopDepth: isLoop ? loopDepth + 1 : loopDepth,
      isLoop,
      armIndex,
      sites: [],
      closeSite: undefined,
      completes: undefined
    });
    return block;
  }

  closeBlock(block: BlockId, closeSite: SiteId, completes: boolean): void {
    const draft = this.#block(block);

    draft.closeSite = closeSite;
    draft.completes = completes;
  }

  blockCompletes(block: BlockId): boolean {
    const completes = this.#block(block).completes;

    assert(completes !== undefined, `block ${block} is not closed`);
    return completes;
  }

  recordProducer(site: SiteId, output: WasmValueId): void {
    assert(
      this.#producers[output] === undefined && this.#joinProducers[output] === undefined,
      `value ${output} already has a producer`
    );
    this.#producers[output] = site;
  }

  recordJoinProducer(
    output: WasmValueId | undefined,
    site: SiteId,
    arms: readonly BlockId[]
  ): void {
    if (output === undefined) {
      return;
    }
    const dependencies: ValueDemand[] = [];

    for (const arm of arms) {
      const closeSite = this.#block(arm).closeSite;

      assert(closeSite !== undefined, `join arm ${arm} is not closed`);
      const close = this.#events[closeSite];

      assert(close?.kind === "close", "value-producing control arm has no close event");
      const result = close.result;

      assert(result !== undefined, "value-producing control arm has no result");
      assert(result < output, `Wasm join input ${result} must precede output ${output}`);
      dependencies.push({ value: result, consumedAt: closeSite });
    }
    assert(
      this.#producers[output] === undefined && this.#joinProducers[output] === undefined,
      `value ${output} already has a join producer`
    );
    this.#joinProducers[output] = site;
    this.#joinDependencies[output] = dependencies;
  }

  #recordEffects(site: SiteId, effects: StorageEffects): void {
    this.#siteReads[site] = effects.reads;
    if (effects.writes.length === 0) {
      return;
    }
    this.#siteHasWrites[site] = 1;
    this.#writeSites.push({ site, writes: effects.writes });
  }

  #block(block: BlockId): BlockDraft {
    const draft = this.#blocks[block];

    assert(draft !== undefined, `unknown Wasm body block ${block}`);
    return draft;
  }
}
