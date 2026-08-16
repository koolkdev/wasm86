import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { buildFunction } from "#compiler/function/builder/function.js";
import { functionType } from "#compiler/function/type.js";
import { Integer } from "#compiler/function/values.js";
import {
  siteId,
  type BlockId,
  type BodyEvent,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { WasmBodyIndex } from "../body-index.js";

test("indexes structured block ownership and ends", () => {
  const body = nestedBody();
  const index = new WasmBodyIndex(body);
  const outerIf = eventSite(body, "if", (site) => site.block === body.entryBlock);
  const loop = eventSite(body, "loop");
  const innerIf = eventSite(body, "if", (site) => site.block === loop.event.body);
  const switched = eventSite(body, "switch");
  const [thenBlock, elseBlock] = outerIf.event.arms;
  const [innerThen] = innerIf.event.arms;
  const [caseBlock, defaultBlock] = switched.event.arms;

  ok(thenBlock !== undefined && elseBlock !== undefined);
  ok(innerThen !== undefined && caseBlock !== undefined && defaultBlock !== undefined);

  deepStrictEqual(index.path(body.entryBlock, innerThen), [
    { block: thenBlock, ownerSite: outerIf.id },
    { block: loop.event.body, ownerSite: loop.id },
    { block: innerThen, ownerSite: innerIf.id }
  ]);
  deepStrictEqual(index.path(elseBlock, caseBlock), [{ block: caseBlock, ownerSite: switched.id }]);
  strictEqual(index.path(elseBlock, innerThen), undefined);

  for (const block of [thenBlock, loop.event.body, innerThen, caseBlock, defaultBlock]) {
    const end = index.site(index.endSite(block));

    strictEqual(end.block, block);
    strictEqual(end.event.kind, "end");
  }

  strictEqual(index.loopOwner(loop.event.body), loop.id);
  strictEqual(index.loopOwner(innerThen), undefined);
  strictEqual(index.loopOwner(caseBlock), undefined);
});

test("projects nested sites through their owning controls", () => {
  const body = nestedBody();
  const index = new WasmBodyIndex(body);
  const outerIf = eventSite(body, "if", (site) => site.block === body.entryBlock);
  const loop = eventSite(body, "loop");
  const innerIf = eventSite(body, "if", (site) => site.block === loop.event.body);
  const switched = eventSite(body, "switch");
  const [innerThen] = innerIf.event.arms;
  const [caseBlock] = switched.event.arms;

  ok(innerThen !== undefined && caseBlock !== undefined);
  const innerEnd = index.endSite(innerThen);
  const loopEnd = index.endSite(loop.event.body);
  const caseEnd = index.endSite(caseBlock);

  strictEqual(index.dominatingSite([innerEnd, loopEnd]), innerIf.id);
  strictEqual(index.dominatingSite([innerEnd, caseEnd]), outerIf.id);
  strictEqual(index.dominatingSite([caseEnd]), caseEnd);
});

function nestedBody(): WasmBody {
  return lowerWasmFunction(
    buildFunction(functionType([Integer[1], Integer[8]], []), (fn) => {
      const [condition, selector] = fn.parameters;

      fn.region.if(
        condition,
        (thenBody) => {
          thenBody.loop([], (loopBody) => {
            loopBody.if(condition, (innerThen) => innerThen.loopContinue([]));
          });
        },
        {
          elseBuild: (elseBody) => {
            elseBody.switchControl(selector, [{ matches: [1], build: () => {} }], () => {});
          }
        }
      );
      fn.return([]);
    })
  );
}

type EventSite<Kind extends BodyEvent["kind"]> = Readonly<{
  id: SiteId;
  block: BlockId;
  event: Extract<BodyEvent, { kind: Kind }>;
}>;

function eventSite<Kind extends BodyEvent["kind"]>(
  body: WasmBody,
  kind: Kind,
  matches: (site: Readonly<{ block: BlockId }>) => boolean = () => true
): EventSite<Kind> {
  const found = body.sites.flatMap((site, raw) =>
    site.event.kind === kind && matches(site)
      ? [{ id: siteId(raw), block: site.block, event: site.event }]
      : []
  );

  strictEqual(found.length, 1, `expected one matching ${kind} event`);
  return found[0] as EventSite<Kind>;
}
