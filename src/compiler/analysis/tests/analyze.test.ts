import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { analyzeFunction as runFunctionAnalysis } from "#compiler/analysis/analyze.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl
} from "#compiler/ir/controls/index.js";
import { IndirectCallTarget, Invocation } from "#compiler/ir/invocation.js";
import { callOperation } from "#compiler/ir/operations/index.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { type RegionNode, type Region } from "#compiler/ir/region.js";
import type { FunctionGraph, IrFunction } from "#compiler/ir/function.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef, tableRef } from "#compiler/reference.js";
import {
  compilerTestResourceEffect,
  compilerTestValues,
  memoryReadOperation,
  memoryWriteOperation,
  resourceReadNode,
  resourceWriteNode
} from "#test/support/storage-operations.js";

const noEffects: StorageEffects = { reads: [], writes: [] };

function functionBlock(
  block: FunctionGraph,
  parameterCount = 0,
  returned: readonly ValueId[] = []
): IrFunction {
  const parameters = Array.from({ length: parameterCount }, (_, index) =>
    block.values.parameter(index, "i32")
  );
  const body =
    returned.length === 0
      ? block.body
      : {
          ...block.body,
          nodes: [
            ...block.body.nodes,
            returnControl.create({
              source: { kind: "values", values: returned }
            })
          ]
        };

  return {
    ...block,
    body,
    type: functionType(
      parameters.map(() => "i32"),
      returned.map((result) => block.values.valueType(result))
    ),
    parameters
  };
}

function analyzeFunction(
  block: FunctionGraph,
  parameterCount = 0,
  returned: readonly ValueId[] = []
) {
  return runFunctionAnalysis(functionBlock(block, parameterCount, returned));
}

test("region geometry relates nested bodies to their owning controls", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const written = values.const(7);
  const loopSeed = values.const(0);
  const loopInput = values.addLoopInput();
  const nestedWrite = resourceWriteNode(values, 1, written);
  const thenBody: Region = { nodes: [nestedWrite] };
  const loopBody: Region = {
    nodes: [loopContinueControl.create({ updates: [loopInput] })]
  };
  const branch = ifControl.create({ condition, thenBody });
  const loop = loopControl.create({
    carried: [{ seed: loopSeed, loopInput }],
    body: loopBody
  });
  const body: Region = { nodes: [branch, loop] };
  const analysis = analyzeFunction({ values, body }, 1);

  const branchSite = analysis.siteOf(body, 0);
  const loopSite = analysis.siteOf(body, 1);

  deepStrictEqual(analysis.path(body, loopBody), [
    {
      region: loopBody,
      owner: loopSite
    }
  ]);
  deepStrictEqual(analysis.path(loopBody, thenBody), undefined);
  strictEqual(analysis.isLoopRegion(loopBody), true);
  strictEqual(analysis.isLoopRegion(thenBody), false);
  strictEqual(
    analysis.dominatingSite([analysis.siteOf(thenBody, 0), analysis.siteOf(loopBody, 0)]),
    branchSite
  );

  deepStrictEqual(analysis.writesAt(analysis.siteOf(body, 0)), [compilerTestResourceEffect(1)]);
  deepStrictEqual(analysis.writesAt(analysis.regionEndSite(thenBody)), []);
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
  const analysis = analyzeFunction({
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
  const address = values.parameter(0, "i32");
  const loaded = values.addNodeOutput();
  const read = memoryReadOperation(loaded, address, 32);
  const firstWrite = resourceWriteNode(values, 0, loaded);
  const secondWrite = resourceWriteNode(values, 1, loaded);
  const analysis = analyzeFunction(
    {
      values,
      body: { nodes: [read, firstWrite, secondWrite] }
    },
    1
  );

  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.isLive(loaded), true);
  strictEqual(analysis.operationMustExecute(read), true);
  strictEqual(analysis.operationMustExecute(firstWrite), true);
});

test("each semantic operation input contributes one use", () => {
  const values = compilerTestValues();
  const stored = values.parameter(0, "i32");
  const address = values.parameter(1, "i32");
  const write = memoryWriteOperation(address, stored, 32);
  const analysis = analyzeFunction(
    {
      values,
      body: { nodes: [write] }
    },
    2
  );

  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.useCount(stored), 1);
});

test("compound dependency edges are charged once per live recipe", () => {
  const values = compilerTestValues();
  const read = values.addNodeOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyzeFunction({
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
  const condition = values.parameter(0, "i32");
  const read = values.addNodeOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyzeFunction(
    {
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
    },
    1
  );

  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.useCount(sum), 2);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(one), 1);
});

test("a use authored in a loop counts once, independent of runtime iterations", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const analysis = analyzeFunction({
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

test("operation, control, loop, and return operands seed liveness", () => {
  const values = compilerTestValues();
  const mutated = values.const(11);
  const condition = values.parameter(0, "i32");
  const nestedMutation = values.const(12);
  const loopSeed = values.const(13);
  const loopInput = values.addLoopInput();
  const increment = values.const(1);
  const loopUpdate = values.binary("add", loopInput, increment);
  const returnResult = values.const64(14n);
  const nodes: readonly RegionNode[] = [
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
    returnControl.create({
      source: {
        kind: "values",
        values: [returnResult]
      }
    })
  ];
  const analysis = analyzeFunction({ values, body: { nodes } }, 1);

  for (const live of [
    mutated,
    condition,
    nestedMutation,
    loopSeed,
    loopInput,
    increment,
    loopUpdate,
    returnResult
  ]) {
    strictEqual(analysis.isLive(live), true, `expected value ${live} to be live`);
  }
});

test("an unreachable arm result executes even when its join is dead", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const safeResult = values.const(7);
  const unreachableResult = values.unreachable();
  const output = values.addNodeOutput();
  const thenBody: Region = { nodes: [], result: safeResult };
  const elseBody: Region = { nodes: [], result: unreachableResult };
  const control = ifControl.create({
    condition,
    output,
    thenBody,
    elseBody
  });
  const block: FunctionGraph = { values, body: { nodes: [control] } };
  const analysis = analyzeFunction(block, 1);
  const unreachableRoot = analysis.roots().find((root) => root.value === unreachableResult);
  const dependencies = analysis.controlDependencies(output);

  strictEqual(analysis.isLive(condition), true);
  strictEqual(analysis.isLive(output), false);
  strictEqual(analysis.isLive(safeResult), false);
  strictEqual(analysis.isLive(unreachableResult), true);
  strictEqual(analysis.useCount(unreachableResult), 1);
  strictEqual(unreachableRoot?.consumedAt, analysis.regionEndSite(elseBody));
  strictEqual(dependencies?.[0]?.consumedAt, analysis.regionEndSite(thenBody));
  strictEqual(dependencies?.[1]?.consumedAt, analysis.regionEndSite(elseBody));
  strictEqual(dependencies?.[1], unreachableRoot);
  deepStrictEqual(analysis.controlProducer(output), {
    site: analysis.siteOf(block.body, 0)
  });

  const returned = analyzeFunction(block, 1, [output]);

  strictEqual(returned.useCount(output), 1);
  strictEqual(returned.useCount(safeResult), 1);
  strictEqual(returned.useCount(unreachableResult), 1);
});

test("a switch retains arm recipes exactly when its output is live", () => {
  const values = compilerTestValues();
  const selector = values.parameter(0, "i32");
  const read = values.addNodeOutput();
  const one = values.const(1);
  const firstResult = values.binary("add", read, one);
  const defaultResult = values.const(2);
  const output = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            {
              matches: [0],
              body: {
                nodes: [resourceReadNode(values, read, 0)],
                result: firstResult
              }
            }
          ],
          defaultBody: { nodes: [], result: defaultResult }
        })
      ]
    }
  };
  const dead = analyzeFunction(block, 1);

  strictEqual(dead.useCount(selector), 1);
  for (const value of [output, firstResult, read, one, defaultResult]) {
    strictEqual(dead.useCount(value), 0, `expected value ${value} to be dead`);
  }

  const live = analyzeFunction(block, 1, [output]);

  strictEqual(live.useCount(selector), 1);
  strictEqual(live.useCount(output), 1);
  strictEqual(live.useCount(firstResult), 1);
  strictEqual(live.useCount(read), 1);
  strictEqual(live.useCount(one), 1);
  strictEqual(live.useCount(defaultResult), 1);
});

test("a control-only switch retains selector and arm effects without a join output", () => {
  const values = compilerTestValues();
  const selector = values.parameter(0, "i32");
  const selectedValue = values.const(11);
  const fallbackValue = values.const(22);
  const selectedBody: Region = {
    nodes: [resourceWriteNode(values, 0, selectedValue)]
  };
  const defaultBody: Region = {
    nodes: [resourceWriteNode(values, 1, fallbackValue)]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          cases: [
            {
              matches: [1, 3, 5],
              body: selectedBody
            }
          ],
          defaultBody
        })
      ]
    }
  };
  const analysis = analyzeFunction(block, 1);

  strictEqual(analysis.isLive(selector), true);
  strictEqual(analysis.isLive(selectedValue), true);
  strictEqual(analysis.isLive(fallbackValue), true);
  deepStrictEqual(analysis.writesAt(analysis.siteOf(block.body, 0)), [
    compilerTestResourceEffect(0),
    compilerTestResourceEffect(1)
  ]);
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
  const call = (output: ValueId) =>
    callOperation.create(
      {
        invocation: Invocation.create({
          target,
          arguments: args
        })
      },
      () => output
    );
  const firstCall = call(first);
  const secondCall = call(second);
  const deadCall = call(dead);
  const analysis = analyzeFunction({
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

  const invocations = analysis.invocations();

  strictEqual(analysis.invocationMustExecute(invocations[0]!), true);
  strictEqual(analysis.invocationMustExecute(invocations[1]!), true);
  strictEqual(analysis.invocationMustExecute(invocations[2]!), false);
  deepStrictEqual(
    invocations.map(({ invocation }) => invocation),
    [firstCall, secondCall, deadCall].map(({ invocation }) => invocation)
  );
  deepStrictEqual(analysis.producer(first)?.inputs, [sourceKind, operandA, operandB, concrete]);
});

test("effectful calls remain live even when their result is unused", () => {
  const values = compilerTestValues();
  const argument = values.parameter(0, "i32");
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
      invocation: Invocation.create({
        target,
        arguments: [{ value: argument, type: "i32" }]
      })
    },
    () => output
  );
  const analysis = analyzeFunction({ values, body: { nodes: [call] } }, 1);
  const invocation = analysis.invocations()[0]!;

  strictEqual(analysis.isLive(output), false);
  strictEqual(analysis.isLive(argument), true);
  strictEqual(analysis.invocationMustExecute(invocation), true);
});

test("invocation liveness follows its owning node", () => {
  const values = compilerTestValues();
  const argument = values.parameter(0, "i32");
  const target = new FunctionDefinition({
    ref: functionRef("tests.analysis.return-call"),
    type: functionType(["i32"], []),
    effects: noEffects,
    owner: undefined,
    build: () => {}
  });
  const invocation = Invocation.create({
    target,
    arguments: [{ value: argument, type: "i32" }]
  });
  const returned = returnControl.create({
    source: { kind: "invocation", invocation }
  });
  const ordinaryCall = callOperation.create({ invocation }, () => {
    throw new Error("resultless invocation allocated an output");
  });
  const body: Region = { nodes: [ordinaryCall, returned] };
  const analysis = analyzeFunction({ values, body }, 1);
  const [callSite, returnSite] = analysis.invocations();

  strictEqual(analysis.invocationMustExecute(callSite!), false);
  strictEqual(analysis.invocationMustExecute(returnSite!), true);
  strictEqual(analysis.isLive(argument), true);
  deepStrictEqual(analysis.invocations(), [
    {
      invocation,
      site: analysis.siteOf(body, 0)
    },
    {
      invocation,
      site: analysis.siteOf(body, 1)
    }
  ]);
});

test("returned indirect invocations root arguments and the table index", () => {
  const values = compilerTestValues();
  const argument = values.parameter(0, "i32");
  const elementIndex = values.parameter(1, "i32");
  const invocation = Invocation.create({
    target: IndirectCallTarget.create({
      table: tableRef("tests.analysis.indirect-call"),
      type: functionType(["i32"], []),
      effects: noEffects,
      elementIndex: { value: elementIndex, type: "i32" }
    }),
    arguments: [{ value: argument, type: "i32" }]
  });
  const returned = returnControl.create({
    source: { kind: "invocation", invocation }
  });
  const analysis = analyzeFunction({ values, body: { nodes: [returned] } }, 2);

  strictEqual(analysis.isLive(argument), true);
  strictEqual(analysis.isLive(elementIndex), true);
});
