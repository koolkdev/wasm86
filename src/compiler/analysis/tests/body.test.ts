import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { analyzeBody } from "#compiler/analysis/analyze.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { Action } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/program/refs.js";
import {
  compilerTestResourceEffect,
  compilerTestValues,
  memoryRead,
  memoryWrite,
  resourceReadAction,
  resourceWriteAction
} from "#ir/tests/storage-op-helpers.js";

const noEffects: StorageEffects = { reads: [], writes: [] };

test("sites form one dense preorder and expose body geometry", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const written = values.const(7);
  const loopSeed = values.const(0);
  const loopInput = values.addLoopInput();
  const nestedWrite = resourceWriteAction(values, 1, written);
  const thenBody: Body = { actions: [nestedWrite] };
  const loopBody: Body = {
    actions: [{ kind: "loopContinue", updates: [loopInput] }]
  };
  const ifAction = { kind: "if", condition, thenBody } as const;
  const loopAction = {
    kind: "loop",
    carried: [{ seed: loopSeed, loopInput }],
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
  const values = compilerTestValues();
  const base = values.addActionOutput();
  const address = values.binary("add", base, values.const(4));
  const byteLength = values.const(4);
  const readBase = resourceReadAction(values, base, 0);
  const analysis = analyzeBody({
    values,
    body: { actions: [readBase] }
  });

  for (const dead of [base, address, byteLength]) {
    strictEqual(analysis.isLive(dead), false);
    strictEqual(analysis.useCount(dead), 0);
  }
  strictEqual(analysis.producer(base)?.action, readBase);
  strictEqual(analysis.opActionMustExecute(readBase), false);
});

test("semantic producer inputs are charged once however often the output is used", () => {
  const values = compilerTestValues();
  const address = values.external(0);
  const loaded = values.addActionOutput();
  const read = memoryRead(loaded, address, 32);
  const firstWrite = resourceWriteAction(values, 0, loaded);
  const secondWrite = resourceWriteAction(values, 1, loaded);
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
  const values = compilerTestValues();
  const stored = values.external(0);
  const address = values.external(1);
  const write = memoryWrite(address, stored, 32);
  const analysis = analyzeBody({
    values,
    body: { actions: [write] }
  });
  const addressUses = write.op.inputs.filter((input) => input.value === address).length;
  const storedUses = write.op.inputs.filter(
    (input) => input.value === stored
  ).length;

  strictEqual(addressUses, 1);
  strictEqual(storedUses, 1);
  strictEqual(analysis.useCount(address), addressUses);
  strictEqual(analysis.useCount(stored), storedUses);
});

test("compound dependency edges are charged once per live recipe", () => {
  const values = compilerTestValues();
  const read = values.addActionOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        resourceReadAction(values, read, 0),
        resourceWriteAction(values, 1, doubled),
        resourceWriteAction(values, 2, doubled)
      ]
    }
  });

  strictEqual(analysis.useCount(doubled), 2);
  strictEqual(analysis.useCount(read), 2);
});

test("selected-body uses count separately while their shared recipe runs once", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        resourceReadAction(values, read, 0),
        {
          kind: "if",
          condition,
          thenBody: { actions: [resourceWriteAction(values, 1, sum)] },
          elseBody: { actions: [resourceWriteAction(values, 2, sum)] }
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
  const values = compilerTestValues();
  const output = values.addActionOutput();
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        resourceReadAction(values, output, 0),
        {
          kind: "loop",
          carried: [],
          body: {
            actions: [
              resourceWriteAction(values, 1, output),
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
  const values = compilerTestValues();
  const mutated = values.const(11);
  const condition = values.external(0);
  const nestedMutation = values.const(12);
  const loopSeed = values.const(13);
  const loopInput = values.addLoopInput();
  const increment = values.const(1);
  const loopUpdate = values.binary("add", loopInput, increment);
  const finishResult = values.const64(14n);
  const actions: readonly Action[] = [
    resourceWriteAction(values, 0, mutated),
    {
      kind: "if",
      condition,
      thenBody: {
        actions: [resourceWriteAction(values, 1, nestedMutation)]
      }
    },
    {
      kind: "loop",
      carried: [{ seed: loopSeed, loopInput }],
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
  const values = compilerTestValues();
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
  const values = compilerTestValues();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const firstResult = values.binary("add", read, one);
  const defaultResult = values.const(2);
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
            actions: [resourceReadAction(values, read, 0)],
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
  const values = compilerTestValues();
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
      resourceReadAction(values, first, 0),
      resourceReadAction(values, second, 1),
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

test("pure call execution follows result liveness", () => {
  const values = compilerTestValues();
  const first = values.addActionOutput(fitsUnsigned(1));
  const second = values.addActionOutput(fitsUnsigned(1));
  const dead = values.addActionOutput(fitsUnsigned(1));
  const sourceKind = values.const(0);
  const operandA = values.const(1);
  const operandB = values.const(2);
  const concrete = values.const(3);
  const target = new FunctionDefinition({
    ref: functionRef("tests.analysis.pure-call"),
    type: functionType(["i32", "i32", "i32", "i32"], ["i32"]),
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const args = [sourceKind, operandA, operandB, concrete].map((value) => ({
    value,
    type: "i32" as const
  }));
  const call = (output: ValueId) => ({
    kind: "call" as const,
    target,
    arguments: args,
    outputs: [output]
  });
  const firstCall = call(first);
  const secondCall = call(second);
  const deadCall = call(dead);
  const analysis = analyzeBody({
    values,
    body: {
      actions: [
        firstCall,
        resourceWriteAction(values, 0, first),
        secondCall,
        resourceWriteAction(values, 1, second),
        deadCall
      ]
    }
  });

  strictEqual(analysis.callActionMustExecute(firstCall), true);
  strictEqual(analysis.callActionMustExecute(secondCall), true);
  strictEqual(analysis.callActionMustExecute(deadCall), false);
  deepStrictEqual(analysis.calls().map((site) => site.action), [
    firstCall,
    secondCall,
    deadCall
  ]);
  deepStrictEqual(analysis.producer(first)?.inputs, [sourceKind, operandA, operandB, concrete]);
});

test("effectful calls remain live even when their result is unused", () => {
  const values = compilerTestValues();
  const argument = values.external(0);
  const output = values.addActionOutput();
  const target = new FunctionDefinition({
    ref: functionRef("tests.analysis.effectful-call"),
    type: functionType(["i32"], ["i32"]),
    effects: { reads: [], writes: [compilerTestResourceEffect(0)] },
    owner: undefined,
    build: () => {}
  });
  const action = {
    kind: "call",
    target,
    arguments: [{ value: argument, type: "i32" }],
    outputs: [output]
  } as const;
  const analysis = analyzeBody({ values, body: { actions: [action] } });

  strictEqual(analysis.isLive(output), false);
  strictEqual(analysis.isLive(argument), true);
  strictEqual(analysis.callActionMustExecute(action), true);
});

test("queries reject unknown values, sites, and bodies", () => {
  const values = compilerTestValues();
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
