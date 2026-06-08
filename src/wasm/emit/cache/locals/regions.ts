import { assert } from "#common/assert.js";
import type { LayoutRegion } from "#ir/block/planning/layout/index.js";

export type WasmCacheActiveRegion = {
  region: LayoutRegion;
};

export type WasmCacheVisibleRegions = readonly WasmCacheActiveRegion[];

export class WasmCacheRegionStack {
  readonly #regions: WasmCacheActiveRegion[] = [];

  enterRegion(region: LayoutRegion): void {
    this.#regions.push({ region });
  }

  activeRegion(): WasmCacheActiveRegion {
    const active = this.#regions.at(-1);

    assert(active !== undefined, "Wasm value cache has no active layout region");
    return active;
  }

  activeRegionChain(): WasmCacheVisibleRegions {
    this.activeRegion();
    return Object.freeze([...this.#regions].reverse());
  }

  leaveRegion(region: LayoutRegion): WasmCacheActiveRegion {
    const active = this.activeRegion();

    assert(
      active.region.id === region.id,
      `cannot leave Wasm cache region ${region.id}; active region is ${active.region.id}`
    );

    this.#regions.pop();
    return active;
  }
}
