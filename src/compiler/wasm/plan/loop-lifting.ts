import { assert } from "#common/assert.js";
import type { SiteId, WasmBody } from "#compiler/wasm/function/body.js";
import { loopBoundary, siteRecord } from "#compiler/wasm/function/geometry.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";

export function liftLoopInvariant(body: WasmBody, value: WasmValueId, anchor: SiteId): SiteId {
  let result = anchor;

  while (true) {
    const next = nextOuterSite(body, value, result);

    if (next === undefined) {
      return result;
    }
    result = next;
  }
}

function nextOuterSite(body: WasmBody, value: WasmValueId, anchor: SiteId): SiteId | undefined {
  if (!body.facts.recipeCanSpeculate(value)) {
    return undefined;
  }
  const loop = loopBoundary(body, siteRecord(body, anchor).block);

  if (loop === undefined || body.facts.requiredLoopDepth(value) >= loop.loopDepth) {
    return undefined;
  }
  assert(loop.ownerSite !== undefined, "loop block has no owner");
  return loop.ownerSite;
}
