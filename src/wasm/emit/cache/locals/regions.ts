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
    return this.#regions.at(-1) ?? fail("Wasm value cache has no active layout region");
  }

  activeRegionChain(): WasmCacheVisibleRegions {
    this.activeRegion();
    return Object.freeze([...this.#regions].reverse());
  }

  leaveRegion(region: LayoutRegion): WasmCacheActiveRegion {
    const active = this.activeRegion();

    if (active.region.id !== region.id) {
      throw new Error(`cannot leave Wasm cache region ${region.id}; active region is ${active.region.id}`);
    }

    this.#regions.pop();
    return active;
  }
}

function fail(message: string): never {
  throw new Error(message);
}
