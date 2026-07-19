import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { analyzeBody } from "#compiler/analysis/analyze.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  finishControl,
  ifControl,
  loopContinueControl,
  loopControl,
  returnCallControl,
  switchControl
} from "#compiler/ir/controls/index.js";
import { callOperation } from "#compiler/ir/operations/index.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { BodyNode, Body, IrBlock } from "#ir/block.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/program/refs.js";
import {
  compilerTestResourceEffect,
  compilerTestValues,
  memoryReadOperation,
  memoryWriteOperation,
  resourceReadNode,
  resourceWriteNode
} from "#ir/tests/storage-op-helpers.js";

const noEffects: StorageEffects = { reads: [], writes: [] };

test("sites form one dense preorder and expose body geometry", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const written = values.const(7);
  const loopSeed = values.const(0);
  const loopInput = values.addLoopInput();
  const nestedWrite = resourceWriteNode(values, 1, written);
  const thenBody: Body = { nodes: [nestedWrite] };
  const loopBody: Body = {
    nodes: [loopContinueControl.create({ updates: [loopInput] })]
  };
  const branch = ifControl.create({ condition, thenBody });
  const loop = loopControl.create({
    carried: [{ seed: loopSeed, loopInput }],
    body: loopBody
  });
  const body: Body = { nodes: [branch, loop] };
  const analysis = analyzeBody({ values, body });

  deepStrictEqual(
    analysis.sites().map((site) => [site.id, site.kind, site.nodeIndex]),
    [
      [0, "node", 0],
      [1, "node", 0],
      [2, "bodyEnd", 1],
      [3, "node", 1],
      [4, "node", 0],
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

  deepStrictEqual(analysis.writesAt(analysis.siteOf(body, 0)), nestedWrite.directEffects.writes);
  deepStrictEqual(analysis.writesAt(analysis.bodyEndSite(thenBody)), []);
  deepStrictEqual(analysis.operations(), [
    { operation: nestedWrite, site: analysis.siteOf(thenBody, 0) }
  ]);
  strictEqual(analysis.operationMustExecute(nestedWrite), true);
});

test("dead producer chains stay dead", () => {
  const values = compilerTestValues();
  const base = values.addNodeOutput();
  const address = values.binary("add", base, values.const(4));
  const byteLength = values.const(4);
  const readBase = resourceReadNode(values, base, 0);
  const analysis = analyzeBody({
    values,
    body: { nodes: [readBase] }
  });

  for (const dead of [base, address, byteLength]) {
    strictEqual(analysis.isLive(dead), false);
    strictEqual(analysis.useCount(dead), 0);
  }
  strictEqual(analysis.producer(base)?.operation, readBase);
  strictEqual(analysis.operationMustExecute(readBase), false);
});

test("semantic producer inputs are charged once however often the output is used", () => {
  const values = compilerTestValues();
  const address = values.external(0);
  const loaded = values.addNodeOutput();
  const read = memoryReadOperation(loaded, address, 32);
  const firstWrite = resourceWriteNode(values, 0, loaded);
  const secondWrite = resourceWriteNode(values, 1, loaded);
  const analysis = analyzeBody({
    values,
    body: { nodes: [read, firstWrite, secondWrite] }
  });

  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.isLive(loaded), true);
  strictEqual(analysis.operationMustExecute(read), true);
  strictEqual(analysis.operationMustExecute(firstWrite), true);
});

test("each semantic operation input contributes one use", () => {
  const values = compilerTestValues();
  const stored = values.external(0);
  const address = values.external(1);
  const write = memoryWriteOperation(address, stored, 32);
  const analysis = analyzeBody({
    values,
    body: { nodes: [write] }
  });
  const addressUses = write.inputs.filter((input) => input.value === address).length;
  const storedUses = write.inputs.filter(
    (input) => input.value === stored
  ).length;

  strictEqual(addressUses, 1);
  strictEqual(storedUses, 1);
  strictEqual(analysis.useCount(address), addressUses);
  strictEqual(analysis.useCount(stored), storedUses);
});

test("compound dependency edges are charged once per live recipe", () => {
  const values = compilerTestValues();
  const read = values.addNodeOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyzeBody({
    values,
    body: {
      nodes: [
        resourceReadNode(values, read, 0),
        resourceWriteNode(values, 1, doubled),
        resourceWriteNode(values, 2, doubled)
      ]
    }
  });

  strictEqual(analysis.useCount(doubled), 2);
  strictEqual(analysis.useCount(read), 2);
});

test("selected-body uses count separately while their shared recipe runs once", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const read = values.addNodeOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyzeBody({
    values,
    body: {
      nodes: [
        resourceReadNode(values, read, 0),
        ifControl.create({
          condition,
          thenBody: { nodes: [resourceWriteNode(values, 1, sum)] },
          elseBody: { nodes: [resourceWriteNode(values, 2, sum)] }
        })
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
  const output = values.addNodeOutput();
  const analysis = analyzeBody({
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 0),
        loopControl.create({
          carried: [],
          body: {
            nodes: [
              resourceWriteNode(values, 1, output),
              loopContinueControl.create({ updates: [] })
            ]
          }
        })
      ]
    }
  });

  strictEqual(analysis.useCount(output), 1);
});

test("operation, control, loop, and finish operands seed liveness", () => {
  const values = compilerTestValues();
  const mutated = values.const(11);
  const condition = values.external(0);
  const nestedMutation = values.const(12);
  const loopSeed = values.const(13);
  const loopInput = values.addLoopInput();
  const increment = values.const(1);
  const loopUpdate = values.binary("add", loopInput, increment);
  const finishResult = values.const64(14n);
  const nodes: readonly BodyNode[] = [
    resourceWriteNode(values, 0, mutated),
    ifControl.create({
      condition,
      thenBody: {
        nodes: [resourceWriteNode(values, 1, nestedMutation)]
      }
    }),
    loopControl.create({
      carried: [{ seed: loopSeed, loopInput }],
      body: {
        nodes: [loopContinueControl.create({ updates: [loopUpdate] })]
      }
    }),
    finishControl.create({
      finish: {
        kind: "exit",
        result: finishResult
      }
    })
  ];
  const analysis = analyzeBody({ values, body: { nodes } });

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
  const output = values.addNodeOutput();
  const thenBody: Body = { nodes: [], result: safeResult };
  const elseBody: Body = { nodes: [], result: unreachableResult };
  const control = ifControl.create({
    condition,
    output,
    thenBody,
    elseBody
  });
  const block: IrBlock = { values, body: { nodes: [control] } };
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
  const read = values.addNodeOutput();
  const one = values.const(1);
  const firstResult = values.binary("add", read, one);
  const defaultResult = values.const(2);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [switchControl.create({
        selector,
        output,
        cases: [{
          match: 0,
          body: {
            nodes: [resourceReadNode(values, read, 0)],
            result: firstResult
          }
        }],
        defaultBody: { nodes: [], result: defaultResult }
      })]
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
  const first = values.addNodeOutput();
  const second = values.addNodeOutput();
  const exitResult = values.const64(0n);
  const finish = finishControl.create({
    finish: {
      kind: "exit",
      result: exitResult
    }
  });
  const body: Body = {
    nodes: [
      resourceReadNode(values, first, 0),
      resourceReadNode(values, second, 1),
      finish
    ]
  };
  const outputs: readonly ValueId[] = [second, first, second];
  const analysis = analyzeBody({ values, body }, outputs);
  const roots = analysis.roots().slice(-outputs.length);
  const terminal = analysis.siteOf(body, body.nodes.length - 1);

  deepStrictEqual(analysis.exportedOutputs(), outputs);
  deepStrictEqual(roots.map((root) => root.value), outputs);
  strictEqual(roots.every((root) => root.consumedAt === terminal), true);
  strictEqual(analysis.useCount(first), 1);
  strictEqual(analysis.useCount(second), 2);
});

test("pure call execution follows result liveness", () => {
  const values = compilerTestValues();
  const first = values.addNodeOutput(fitsUnsigned(1));
  const second = values.addNodeOutput(fitsUnsigned(1));
  const dead = values.addNodeOutput(fitsUnsigned(1));
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
  const call = (output: ValueId) => callOperation.create(
    { target, arguments: args },
    () => output
  );
  const firstCall = call(first);
  const secondCall = call(second);
  const deadCall = call(dead);
  const analysis = analyzeBody({
    values,
    body: {
      nodes: [
        firstCall,
        resourceWriteNode(values, 0, first),
        secondCall,
        resourceWriteNode(values, 1, second),
        deadCall
      ]
    }
  });

  strictEqual(analysis.callMustExecute(firstCall), true);
  strictEqual(analysis.callMustExecute(secondCall), true);
  strictEqual(analysis.callMustExecute(deadCall), false);
  deepStrictEqual(analysis.calls().map((site) => site.call), [
    firstCall,
    secondCall,
    deadCall
  ]);
  deepStrictEqual(analysis.producer(first)?.inputs, [sourceKind, operandA, operandB, concrete]);
});

test("effectful calls remain live even when their result is unused", () => {
  const values = compilerTestValues();
  const argument = values.external(0);
  const output = values.addNodeOutput();
  const target = new FunctionDefinition({
    ref: functionRef("tests.analysis.effectful-call"),
    type: functionType(["i32"], ["i32"]),
    effects: { reads: [], writes: [compilerTestResourceEffect(0)] },
    owner: undefined,
    build: () => {}
  });
  const call = callOperation.create(
    {
      target,
      arguments: [{ value: argument, type: "i32" }]
    },
    () => output
  );
  const analysis = analyzeBody({ values, body: { nodes: [call] } });

  strictEqual(analysis.isLive(output), false);
  strictEqual(analysis.isLive(argument), true);
  strictEqual(analysis.callMustExecute(call), true);
});

test("return calls are mandatory terminal call edges", () => {
  const values = compilerTestValues();
  const argument = values.external(0);
  const target = new FunctionDefinition({
    ref: functionRef("tests.analysis.return-call"),
    type: functionType(["i32"], []),
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const call = returnCallControl.create({
    target,
    arguments: [{ value: argument, type: "i32" }]
  });
  const analysis = analyzeBody({ values, body: { nodes: [call] } });

  strictEqual(analysis.callMustExecute(call), true);
  strictEqual(analysis.isLive(argument), true);
  deepStrictEqual(analysis.calls(), [{ call, site: analysis.siteOf(analysis.sites()[0]!.body, 0) }]);
});

test("queries reject unknown values, sites, and bodies", () => {
  const values = compilerTestValues();
  const analysis = analyzeBody({ values, body: { nodes: [] } });
  const unknownValue = 99 as ValueId;
  const foreignBody: Body = { nodes: [] };

  throws(() => analysis.isLive(unknownValue), /unknown value id 99/);
  throws(() => analysis.siteOf(foreignBody, 0), /not part of this analysis/);
  throws(
    () => analysis.writesAt(99 as ReturnType<typeof analysis.siteOf>),
    /unknown body analysis site 99/
  );
  throws(() => analysis.dominatingSite([]), /no sites/);
});
