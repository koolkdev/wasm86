import type { ValueRef } from "#compiler/function/values.js";
import type { BlockId, SiteId, WasmBody } from "#compiler/wasm/function/body.js";
import { blockInfo, siteRecord } from "#compiler/wasm/function/geometry.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

export function siteTypeContract(
  body: WasmBody,
  site: SiteId,
  block: BlockId,
  source: ValueRef,
  wasm: WasmValueId
): void {
  siteRecord(body, site);
  blockInfo(body, block);

  // @ts-expect-error body sites are distinct from logical value identities.
  siteRecord(body, source);
  // @ts-expect-error body sites are distinct from Wasm value identities.
  siteRecord(body, wasm);
  // @ts-expect-error blocks are distinct from the sites they hold.
  blockInfo(body, site);
}
