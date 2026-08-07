import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";
import { buildFunction } from "#compiler/function/builder/function.js";
import { Integer, functionType } from "#compiler/function/type.js";
import { nonzero } from "#compiler/function/values.js";
import { blockId, bodyEvent, siteId } from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { blockInfo, blockPath, dominatingSite, loopBoundary } from "../geometry.js";

test("the block table projects nested sites through their owning controls", () => {
  const body = lowerWasmFunction(
    buildFunction(functionType([Integer[32]], []), (fn) => {
      const [condition] = fn.parameters;

      fn.region.if(nonzero(condition), () => {});
      fn.region.loop([], (loop) => loop.loopContinue([]));
      fn.return([]);
    })
  );
  const entryBlock = blockId(body.blocks.findIndex((block) => block.parent === undefined));
  const branchSite = siteId(body.events.findIndex((event) => event.kind === "if"));
  const loopSite = siteId(body.events.findIndex((event) => event.kind === "loop"));
  const thenBlock = blockId(body.blocks.findIndex((block) => block.ownerSite === branchSite));
  const loopBlock = blockId(body.blocks.findIndex((block) => block.ownerSite === loopSite));

  ok(entryBlock >= 0 && branchSite >= 0 && loopSite >= 0 && thenBlock >= 0 && loopBlock >= 0);
  const thenEnd = blockInfo(body, thenBlock).closeSite;
  const loopEnd = blockInfo(body, loopBlock).closeSite;
  const entryClose = bodyEvent(body, blockInfo(body, entryBlock).closeSite);

  deepStrictEqual(blockPath(body, entryBlock, loopBlock), [
    { block: loopBlock, ownerSite: loopSite }
  ]);
  strictEqual(blockPath(body, loopBlock, thenBlock), undefined);
  strictEqual(loopBoundary(body, loopBlock)?.ownerSite, loopSite);
  strictEqual(loopBoundary(body, loopBlock)?.loopDepth, 1);
  strictEqual(loopBoundary(body, thenBlock), undefined);
  strictEqual(dominatingSite(body, [thenEnd, loopEnd]), branchSite);
  ok(entryClose.kind === "close");
  strictEqual(entryClose.block, entryBlock);
});
