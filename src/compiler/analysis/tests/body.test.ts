import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { analyzeBody } from "#compiler/analysis/analyze.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Action } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import {
  memoryCheck,
  memoryRead,
  resolveFlag,
  stateRead,
  stateWrite
} from "#ir/tests/storage-op-helpers.js";

test("sites form one dense preorder and expose body geometry", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const written = values.const(7);
  const loopSeed = values.const(0);
  const loopInput = values.addLoopInput();
  const nestedWrite = stateWrite(gprChannel("ebx"), written);
  const thenBody: Body = { actions: [nestedWrite] };
  const loopBody: Body = {
    actions: [{ kind: "loopContinue", updates: [loopInput] }]
  };
  const ifAction = { kind: "if", condition, thenBody } as const;
  const loopAction = {
    kind: "loop",
    carried: [{ channel: gprChannel("eax"), seed: loopSeed, loopInput }],
    body: loopBody
  } as const;
  const body: Body = { actions: [ifAction, loopAction] };
  const analysis = analyzeBody({ values, body });

  deepStrictEqual(
    analysis.sites().map((site) => [site.id, site.kind, site.actionIndex]),
    [
      [0, "action", 0],
      [1, "action", 0],
      [2, "bodyEnd", 1],
      [3, "action", 1],
      [4, "action", 0],
      [5, "bodyEnd", 1],
      [6, "bodyEnd", 2]
    ]
  );
  strictEqual(analysis.sites().length, 7);
  strictEqual(analysis.siteOf(body, 0), 0);
  strictEqual(analysis.bodyEndSite(body), 6);
  deepStrictEqual(analysis.path(body, loopBody), [{ body: loopBody, owner: 3 }]);
  deepStrictEqual(analysis.path(loopBody, thenBody), undefined);
  strictEqual(analysis.isLoopBody(loopBody), true);
  strictEqual(analysis.isLoopBody(thenBody), false);
  strictEqual(
    analysis.dominatingSite([
      analysis.siteOf(thenBody, 0),
      analysis.siteOf(loopBody, 0)
    ]),
    analysis.siteOf(body, 0)
  );

  deepStrictEqual(analysis.writesAt(analysis.siteOf(body, 0)), nestedWrite.op.effects.writes);
  deepStrictEqual(analysis.writesAt(analysis.bodyEndSite(thenBody)), []);
  deepStrictEqual(analysis.operations(), [
    { action: nestedWrite, site: analysis.siteOf(thenBody, 0) }
  ]);
  strictEqual(analysis.opActionMustExecute(nestedWrite), true);
});

test("dead producer chains stay dead", () => {
  const values = new ValueTable();
  const base = values.addActionOutput();
  const address = values.binary("add", base, values.const(4));
  const byteLength = values.const(4);
  const checked = values.addActionOutput(fitsUnsigned(1));
  const readBase = stateRead(base, gprChannel("eax"));
  const check = memoryCheck(checked, address, byteLength);
  const analysis = analyzeBody({
    values,
    body: { actions: [readBase, check] }
  });

  for (const dead of [base, address, byteLength, checked]) {
    strictEqual(analysis.isLive(dead), false);
    strictEqual(analysis.useCount(dead), 0);
  }
  strictEqual(analysis.producer(base)?.action, readBase);
  deepStrictEqual(
    analysis.producer(checked)?.inputs,
    check.op.inputs.map((input) => input.value)
  );
  strictEqual(analysis.opActionMustExecute(readBase), false);
  strictEqual(analysis.opActionMustExecute(check), false);
});

test("semantic producer inputs are charged once however often the output is used", () => {
  const values = new ValueTable();
  const address = values.external(0);
  const loaded = values.addActionOutput();
  const read = memoryRead(loaded, address, 32);
  const firstWrite = stateWrite(gprChannel("eax"), loaded);
  const secondWrite = stateWrite(gprChannel("ebx"), loaded);
  const analysis = analyzeBody({
    values,
    body: { actions: [read, firstWrite, secondWrite] }
  });

  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.isLive(loaded), true);
  strictEqual(analysis.opActionMustExecute(read), true);
  strictEqual(analysis.opActionMustExecute(firstWrite), true);
});

test("each semantic operation input contributes one use", () => {
  const values = new ValueTable();
  const byteLength = values.external(0);
  const address = values.external(1);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const check = memoryCheck(fault, address, byteLength);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [check, stateWrite(gprChannel("eax"), fault)]
    }
  });
  const addressUses = check.op.inputs.filter((input) => input.value === address).length;
  const byteLengthUses = check.op.inputs.filter(
    (input) => input.value === byteLength
  ).length;

  strictEqual(addressUses, 1);
  strictEqual(byteLengthUses, 1);
  strictEqual(analysis.useCount(fault), 1);
  strictEqual(analysis.useCount(address), addressUses);
  strictEqual(analysis.useCount(byteLength), byteLengthUses);
  deepStrictEqual(
    analysis.producer(fault)?.inputs,
    check.op.inputs.map((input) => input.value)
  );
});

test("compound dependency edges are charged once per live recipe", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        stateRead(read, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), doubled),
        stateWrite(gprChannel("ecx"), doubled)
      ]
    }
  });

  strictEqual(analysis.useCount(doubled), 2);
  strictEqual(analysis.useCount(read), 2);
});

test("selected-body uses count separately while their shared recipe runs once", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        stateRead(read, gprChannel("eax")),
        {
          kind: "if",
          condition,
          thenBody: { actions: [stateWrite(gprChannel("ebx"), sum)] },
          elseBody: { actions: [stateWrite(gprChannel("ecx"), sum)] }
        }
      ]
    }
  });

  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.useCount(sum), 2);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(one), 1);
});

test("a use authored in a loop counts once, independent of runtime iterations", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        {
          kind: "loop",
          carried: [],
          body: {
            actions: [
              stateWrite(gprChannel("ebx"), output),
              { kind: "loopContinue", updates: [] }
            ]
          }
        }
      ]
    }
  });

  strictEqual(analysis.useCount(output), 1);
});

test("action, control, loop, and finish operands seed liveness", () => {
  const values = new ValueTable();
  const mutated = values.const(11);
  const condition = values.external(0);
  const nestedMutation = values.const(12);
  const loopSeed = values.const(13);
  const loopInput = values.addLoopInput();
  const increment = values.const(1);
  const loopUpdate = values.binary("add", loopInput, increment);
  const finishResult = values.const64(14n);
  const actions: readonly Action[] = [
    stateWrite(gprChannel("eax"), mutated),
    {
      kind: "if",
      condition,
      thenBody: {
        actions: [stateWrite(gprChannel("ebx"), nestedMutation)]
      }
    },
    {
      kind: "loop",
      carried: [{ channel: gprChannel("ecx"), seed: loopSeed, loopInput }],
      body: {
        actions: [{ kind: "loopContinue", updates: [loopUpdate] }]
      }
    },
    {
      kind: "finish",
      finish: {
        kind: "exit",
        result: finishResult
      }
    }
  ];
  const analysis = analyzeBody({ values, body: { actions } });

  for (const live of [
    mutated,
    condition,
    nestedMutation,
    loopSeed,
    loopInput,
    increment,
    loopUpdate,
    finishResult
  ]) {
    strictEqual(analysis.isLive(live), true, `expected value ${live} to be live`);
  }
});

test("an unreachable arm result executes even when its join is dead", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const safeResult = values.const(7);
  const unreachableResult = values.unreachable();
  const output = values.addActionOutput();
  const thenBody: Body = { actions: [], result: safeResult };
  const elseBody: Body = { actions: [], result: unreachableResult };
  const action = {
    kind: "if",
    condition,
    output,
    thenBody,
    elseBody
  } as const;
  const block: IrBlock = { values, body: { actions: [action] } };
  const analysis = analyzeBody(block);
  const unreachableRoot = analysis.roots().find(
    (root) => root.value === unreachableResult
  );
  const dependencies = analysis.controlDependencies(output);

  strictEqual(analysis.isLive(condition), true);
  strictEqual(analysis.isLive(output), false);
  strictEqual(analysis.isLive(safeResult), false);
  strictEqual(analysis.isLive(unreachableResult), true);
  strictEqual(analysis.useCount(unreachableResult), 1);
  strictEqual(unreachableRoot?.consumedAt, analysis.bodyEndSite(elseBody));
  strictEqual(dependencies?.[0]?.consumedAt, analysis.bodyEndSite(thenBody));
  strictEqual(dependencies?.[1]?.consumedAt, analysis.bodyEndSite(elseBody));
  strictEqual(dependencies?.[1], unreachableRoot);
  deepStrictEqual(analysis.controlProducer(output), {
    action,
    site: analysis.siteOf(block.body, 0)
  });

  const exported = analyzeBody(block, [output]);

  strictEqual(exported.useCount(output), 1);
  strictEqual(exported.useCount(safeResult), 1);
  strictEqual(exported.useCount(unreachableResult), 1);
});

test("a switch retains arm recipes exactly when its output is live", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const firstResult = values.binary("add", read, one);
  const defaultResult = values.const(0);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "switch",
        selector,
        output,
        cases: [{
          match: 0,
          body: {
            actions: [stateRead(read, gprChannel("eax"))],
            result: firstResult
          }
        }],
        defaultBody: { actions: [], result: defaultResult }
      }]
    }
  };
  const dead = analyzeBody(block);

  strictEqual(dead.useCount(selector), 1);
  for (const value of [output, firstResult, read, one, defaultResult]) {
    strictEqual(dead.useCount(value), 0, `expected value ${value} to be dead`);
  }

  const live = analyzeBody(block, [output]);

  strictEqual(live.useCount(selector), 1);
  strictEqual(live.useCount(output), 1);
  strictEqual(live.useCount(firstResult), 1);
  strictEqual(live.useCount(read), 1);
  strictEqual(live.useCount(one), 1);
  strictEqual(live.useCount(defaultResult), 1);
});

test("export roots preserve order and use the terminal boundary", () => {
  const values = new ValueTable();
  const first = values.addActionOutput();
  const second = values.addActionOutput();
  const exitResult = values.const64(0n);
  const finish = {
    kind: "finish",
    finish: {
      kind: "exit",
      result: exitResult
    }
  } as const;
  const body: Body = {
    actions: [
      stateRead(first, gprChannel("eax")),
      stateRead(second, gprChannel("ebx")),
      finish
    ]
  };
  const outputs: readonly ValueId[] = [second, first, second];
  const analysis = analyzeBody({ values, body }, outputs);
  const roots = analysis.roots().slice(-outputs.length);
  const terminal = analysis.siteOf(body, body.actions.length - 1);

  deepStrictEqual(analysis.exportedOutputs(), outputs);
  deepStrictEqual(roots.map((root) => root.value), outputs);
  strictEqual(roots.every((root) => root.consumedAt === terminal), true);
  strictEqual(analysis.useCount(first), 1);
  strictEqual(analysis.useCount(second), 2);
});

test("operation execution follows result liveness", () => {
  const values = new ValueTable();
  const first = values.addActionOutput(fitsUnsigned(1));
  const second = values.addActionOutput(fitsUnsigned(1));
  const dead = values.addActionOutput(fitsUnsigned(1));
  const firstResolve = resolveFlag(first, "ZF");
  const secondResolve = resolveFlag(second, "ZF");
  const deadResolve = resolveFlag(dead, "CF");
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        firstResolve,
        stateWrite(gprChannel("eax"), first),
        secondResolve,
        stateWrite(gprChannel("ebx"), second),
        deadResolve
      ]
    }
  });

  strictEqual(analysis.opActionMustExecute(firstResolve), true);
  strictEqual(analysis.opActionMustExecute(secondResolve), true);
  strictEqual(analysis.opActionMustExecute(deadResolve), false);
});

test("queries reject unknown values, sites, and bodies", () => {
  const values = new ValueTable();
  const analysis = analyzeBody({ values, body: { actions: [] } });
  const unknownValue = 99 as ValueId;
  const foreignBody: Body = { actions: [] };

  throws(() => analysis.isLive(unknownValue), /unknown value id 99/);
  throws(() => analysis.siteOf(foreignBody, 0), /not part of this analysis/);
  throws(
    () => analysis.writesAt(99 as ReturnType<typeof analysis.siteOf>),
    /unknown body analysis site 99/
  );
  throws(() => analysis.dominatingSite([]), /no sites/);
});
