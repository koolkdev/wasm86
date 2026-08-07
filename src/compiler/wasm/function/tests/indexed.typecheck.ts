import type { SiteIndexed, ValueIndexed } from "#compiler/wasm/function/body.js";

export function indexedTypeContract(
  sites: SiteIndexed<number>,
  values: ValueIndexed<number>,
  plain: readonly number[]
): void {
  readSiteIndexed(sites);
  readValueIndexed(values);

  // @ts-expect-error value-indexed arrays do not answer to site ids.
  readSiteIndexed(values);
  // @ts-expect-error site-indexed arrays do not answer to Wasm value ids.
  readValueIndexed(sites);
  // @ts-expect-error positional arrays come from the indexed factories.
  readSiteIndexed(plain);
}

function readSiteIndexed(_entries: SiteIndexed<number>): void {}

function readValueIndexed(_entries: ValueIndexed<number>): void {}
