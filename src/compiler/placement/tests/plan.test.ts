import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl
} from "#compiler/ir/controls/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import { placeFunction } from "#compiler/placement/place.js";
import { functionType } from "#compiler/program/function-type.js";
import { bodyCompletes, type Body, type BodyNode, type IrBlock } from "#ir/block.js";
import type { IrFunction } from "#ir/function.js";
import { RegionBuilder } from "#ir/region-builder.js";
import {
  compilerTestValues,
  memoryWriteOperation,
  resourceReadNode,
  resourceWriteNode
} from "#ir/tests/storage-op-helpers.js";

function functionBlock(
  block: IrBlock,
  results: readonly ValueType[] = [],
  returned: readonly ValueId[] = []
): IrFunction {
  if (!bodyCompletes(block.body)) {
    (block.body.nodes as BodyNode[]).push(returnControl.create({
      source: { kind: "values", values: returned }
    }));
  }
  const parameters = Array.from(
    { length: block.values.size() },
    (_, raw) => valueId(raw)
  ).filter((value) => block.values.node(value).kind === "parameter")
    .sort((a, b) => {
      const first = block.values.node(a);
      const second = block.values.node(b);

      return first.kind === "parameter" && second.kind === "parameter"
        ? first.index - second.index
        : 0;
    });

  return {
    ...block,
    type: functionType(
      parameters.map((parameter) => block.values.valueType(parameter)),
      results
    ),
    parameters
  };
}

function place(block: IrBlock, returned?: ValueId) {
  return placeFunction(functionBlock(
    block,
    returned === undefined ? [] : [block.values.valueType(returned)],
    returned === undefined ? [] : [returned]
  ));
}

test("a producer used only in a selected body realizes at that use", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const output = values.addNodeOutput();
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 1, output)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 0),
        ifControl.create({ condition, thenBody })
      ]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(thenBody, 0);

  deepStrictEqual(Object.keys(plan), [
    "values",
    "localTypes",
    "cellLocals"
  ]);
  deepStrictEqual(plan.values[output], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
  deepStrictEqual(plan.localTypes, []);
});

test("a recipe used only in a selected body stays at its use", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const result = values.binary("add", values.parameter(1, "i32"), values.const(1));
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, result)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({ condition, thenBody })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(thenBody, 0);

  deepStrictEqual(plan.values[result], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
  deepStrictEqual(plan.localTypes, []);
});

test("identical recipes authored by sibling if arms stay at their selected uses", () => {
  const values = compilerTestValues();
  const builder = new RegionBuilder(values);
  const condition = values.parameter(0, "i32");
  const input = values.parameter(1, "i32");
  const increment = values.const(1);
  let thenResult: ValueId | undefined;
  let elseResult: ValueId | undefined;

  builder.if(
    condition,
    (then) => {
      thenResult = then.values.binary("add", input, increment);
      then.push(resourceWriteNode(then.values, 0, thenResult));
    },
    {
      elseBuild: (otherwise) => {
        elseResult = otherwise.values.binary("add", input, increment);
        otherwise.push(resourceWriteNode(otherwise.values, 1, elseResult));
      }
    }
  );
  const block: IrBlock = { values, body: builder.build() };
  const control = block.body.nodes[0];

  if (thenResult === undefined || elseResult === undefined) {
    throw new Error("if arm recipes were not built");
  }
  if (control?.kind !== "if" || control.elseBody === undefined) {
    throw new Error("expected an if with two arms");
  }

  strictEqual(thenResult === elseResult, false);

  const { analysis, plan, index } = place(block);
  const controlSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[thenResult], {
    kind: "atUse",
    anchor: analysis.siteOf(control.thenBody, 0),
    local: undefined
  });
  deepStrictEqual(plan.values[elseResult], {
    kind: "atUse",
    anchor: analysis.siteOf(control.elseBody, 0),
    local: undefined
  });
  strictEqual(index.captures[controlSite], undefined);
  deepStrictEqual(plan.localTypes, []);
});

test("a recipe shared with parent flow anchors at the common dominator", () => {
  const values = compilerTestValues();
  const shared = values.binary("add", values.parameter(0, "i32"), values.const(1));
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, shared)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({ condition: shared, thenBody })]
    }
  };
  const { analysis, plan } = place(block);
  const controlSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[shared], {
    kind: "atUse",
    anchor: controlSite,
    local: 0
  });
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("a return result is placed at its selected return", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const payload = values.parameter(1, "i32");
  const result = values.binary64(
    "or",
    values.extend64(32, payload, false),
    values.const64(0x1200n)
  );
  const thenBody: Body = {
    nodes: [returnControl.create({
      source: { kind: "values", values: [result] }
    })]
  };
  const elseBody: Body = {
    nodes: [returnControl.create({
      source: { kind: "values", values: [values.const64(0n)] }
    })]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({ condition, thenBody, elseBody })]
    }
  };
  const { analysis, plan } = placeFunction(functionBlock(block, ["i64"]));
  const returnSite = analysis.siteOf(thenBody, 0);

  deepStrictEqual(plan.values[result], {
    kind: "atUse",
    anchor: returnSite,
    local: undefined
  });
  deepStrictEqual(plan.localTypes, []);
});

test("an aliasing write captures a producer at its authored site", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const output = values.addNodeOutput();
  const thenBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, values.const(5)),
      resourceWriteNode(values, 1, output)
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 0),
        ifControl.create({ condition, thenBody })
      ]
    }
  };
  const { analysis, plan, index } = place(block);
  const producerSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[output], {
    kind: "capture",
    anchor: producerSite,
    local: 0
  });
  deepStrictEqual(index.captures[producerSite], [output]);
});

test("operation-local repetition does not create a placement local", () => {
  const values = compilerTestValues();
  const address = values.parameter(0, "i32");
  const base = values.parameter(1, "i32");
  const increment = values.const(1);
  const byteLength = values.binary("add", base, increment);
  const write = memoryWriteOperation(address, byteLength, 32);
  const block: IrBlock = {
    values,
    body: { nodes: [write] }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(block.body, 0);

  strictEqual(analysis.useCount(byteLength), 1);
  deepStrictEqual(plan.values[byteLength], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("an outer producer used by a loop is captured in the preheader", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const loopInput = values.addLoopInput();
  const loopBody: Body = {
    nodes: [resourceWriteNode(values, 1, output)]
  };
  const loop = loopControl.create({
    carried: [{ seed: output, loopInput }],
    body: loopBody
  });
  const block: IrBlock = {
    values,
    body: { nodes: [resourceReadNode(values, output, 0), loop] }
  };
  const { analysis, plan, index } = place(block);
  const preheader = analysis.siteOf(block.body, 1);

  deepStrictEqual(plan.values[output], {
    kind: "atUse",
    anchor: preheader,
    local: 0
  });
  strictEqual(index.captures[preheader], undefined);
});

test("a loop-invariant recipe captures at the loop entry", () => {
  const values = compilerTestValues();
  const invariant = values.binary("add", values.parameter(0, "i32"), values.const(1));
  const loopBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, invariant),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan, index } = place(block);
  const entry = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[invariant], {
    kind: "capture",
    anchor: entry,
    local: 0
  });
  deepStrictEqual(index.captures[entry], [invariant]);
});

test("a loop-input recipe remains inside the loop", () => {
  const values = compilerTestValues();
  const loopInput = values.addLoopInput();
  const current = values.binary("add", loopInput, values.const(1));
  const loopBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, current),
      loopContinueControl.create({ updates: [loopInput] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({
        carried: [{ seed: values.const(0), loopInput }],
        body: loopBody
      })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(loopBody, 0);

  deepStrictEqual(plan.values[current], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("a recipe over a loop-local output remains inside the loop", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const current = values.binary("add", output, values.const(1));
  const loopBody: Body = {
    nodes: [
      resourceReadNode(values, output, 0),
      resourceWriteNode(values, 1, current),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(loopBody, 1);

  deepStrictEqual(plan.values[current], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("a recipe over a loop-local control output remains inside the loop", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const whenTrue = values.const(1);
  const whenFalse = values.const(2);
  const selected = values.addNodeOutput();
  const current = values.binary("add", selected, values.const(1));
  const loopBody: Body = {
    nodes: [
      ifControl.create({
        condition,
        output: selected,
        thenBody: { nodes: [], result: whenTrue },
        elseBody: { nodes: [], result: whenFalse }
      }),
      resourceWriteNode(values, 0, current),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(loopBody, 1);

  deepStrictEqual(plan.values[current], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("a transitively trapping recipe remains inside the loop", () => {
  const values = compilerTestValues();
  const quotient = values.binary(
    "div_u",
    values.parameter(0, "i32"),
    values.parameter(1, "i32")
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const loopBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, adjusted),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(loopBody, 0);

  deepStrictEqual(plan.values[adjusted], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("an invariant recipe in a selected loop body stays selected", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const invariant = values.binary("add", values.parameter(1, "i32"), values.const(1));
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, invariant)]
  };
  const loopBody: Body = {
    nodes: [
      ifControl.create({ condition, thenBody }),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan } = place(block);
  const useSite = analysis.siteOf(thenBody, 0);

  deepStrictEqual(plan.values[invariant], {
    kind: "atUse",
    anchor: useSite,
    local: undefined
  });
});

test("an invariant shared by both loop arms captures at the loop entry", () => {
  const values = compilerTestValues();
  const invariant = values.binary("add", values.parameter(1, "i32"), values.const(1));
  const loopBody: Body = {
    nodes: [
      ifControl.create({
        condition: values.parameter(0, "i32"),
        thenBody: {
          nodes: [resourceWriteNode(values, 0, invariant)]
        },
        elseBody: {
          nodes: [resourceWriteNode(values, 1, invariant)]
        }
      }),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { analysis, plan, index } = place(block);
  const entry = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[invariant], {
    kind: "capture",
    anchor: entry,
    local: 0
  });
  deepStrictEqual(index.captures[entry], [invariant]);
});

test("an outer-loop recipe captures at an inner loop entry", () => {
  const values = compilerTestValues();
  const outerInput = values.addLoopInput();
  const current = values.binary("add", outerInput, values.const(1));
  const innerBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, current),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const outerBody: Body = {
    nodes: [
      loopControl.create({ carried: [], body: innerBody }),
      loopContinueControl.create({ updates: [outerInput] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({
        carried: [{ seed: values.const(0), loopInput: outerInput }],
        body: outerBody
      })]
    }
  };
  const { analysis, plan, index } = place(block);
  const innerEntry = analysis.siteOf(outerBody, 0);

  deepStrictEqual(plan.values[current], {
    kind: "capture",
    anchor: innerEntry,
    local: 1
  });
  deepStrictEqual(index.captures[innerEntry], [current]);
});

test("an invariant recipe crosses nested loop entries", () => {
  const values = compilerTestValues();
  const invariant = values.binary("add", values.parameter(0, "i32"), values.const(1));
  const innerBody: Body = {
    nodes: [
      resourceWriteNode(values, 0, invariant),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const outerBody: Body = {
    nodes: [
      loopControl.create({ carried: [], body: innerBody }),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: outerBody })]
    }
  };
  const { analysis, plan, index } = place(block);
  const outerEntry = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[invariant], {
    kind: "capture",
    anchor: outerEntry,
    local: 0
  });
  deepStrictEqual(index.captures[outerEntry], [invariant]);
});

test("an if operand realizes at use before its nested replay", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 1, output)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 0),
        ifControl.create({ condition: output, thenBody })
      ]
    }
  };
  const { analysis, plan } = place(block);
  const controlSite = analysis.siteOf(block.body, 1);

  deepStrictEqual(plan.values[output], {
    kind: "atUse",
    anchor: controlSite,
    local: 0
  });
});

test("an if can capture a contextually safe value after its condition", () => {
  const values = compilerTestValues();
  const quotient = values.binary(
    "div_u",
    values.parameter(0, "i32"),
    values.parameter(1, "i32")
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, adjusted)]
  };
  const elseBody: Body = {
    nodes: [resourceWriteNode(values, 1, adjusted)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: quotient,
        thenBody,
        elseBody
      })]
    }
  };
  const { analysis, plan, index } = place(block);
  const controlSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[quotient], {
    kind: "atUse",
    anchor: controlSite,
    local: 0
  });
  deepStrictEqual(plan.values[adjusted], {
    kind: "capture",
    anchor: controlSite,
    local: 1
  });
  deepStrictEqual(index.captures[controlSite], [adjusted]);
});

test("an unreachable structured operand makes pending captures safe", () => {
  const values = compilerTestValues();
  const unreachable = values.unreachable();
  const wrapped = values.unary("eqz", unreachable);
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, wrapped)]
  };
  const elseBody: Body = {
    nodes: [resourceWriteNode(values, 1, wrapped)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: unreachable,
        thenBody,
        elseBody
      })]
    }
  };
  const { analysis, plan, index } = place(block);
  const controlSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[wrapped], {
    kind: "capture",
    anchor: controlSite,
    local: 0
  });
  deepStrictEqual(index.captures[controlSite], [wrapped]);
});

test("an earlier captured trap frontier makes a later pre-evaluation safe", () => {
  const values = compilerTestValues();
  const quotient = values.binary(
    "div_u",
    values.parameter(0, "i32"),
    values.parameter(1, "i32")
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const condition = values.parameter(2, "i32");
  const thenBody: Body = {
    nodes: [resourceWriteNode(values, 0, adjusted)]
  };
  const elseBody: Body = {
    nodes: [resourceWriteNode(values, 1, adjusted)]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        resourceWriteNode(values, 2, quotient),
        ifControl.create({ condition, thenBody, elseBody })
      ]
    }
  };
  const { analysis, plan, index } = place(block);
  const controlSite = analysis.siteOf(block.body, 1);

  deepStrictEqual(plan.values[quotient], {
    kind: "atUse",
    anchor: analysis.siteOf(block.body, 0),
    local: 0
  });
  deepStrictEqual(plan.values[adjusted], {
    kind: "capture",
    anchor: controlSite,
    local: 1
  });
  deepStrictEqual(index.captures[controlSite], [adjusted]);
});

test("an unrelated trap shared by only some switch arms has no deadline", () => {
  const values = compilerTestValues();
  const selector = values.parameter(0, "i32");
  const quotient = values.binary(
    "div_u",
    values.parameter(1, "i32"),
    values.parameter(2, "i32")
  );
  const fallback = values.const(7);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            { matches: [0], body: { nodes: [], result: quotient } },
            { matches: [1], body: { nodes: [], result: quotient } }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        resourceWriteNode(values, 0, output)
      ]
    }
  };

  throws(
    () => place(block),
    /trapping value .* has no legal capture deadline/
  );
});

test("a loop input carries its local without an evaluation anchor", () => {
  const values = compilerTestValues();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();
  const loopBody: Body = {
    nodes: [loopContinueControl.create({ updates: [loopInput] })]
  };
  const block: IrBlock = {
    values,
    body: {
      nodes: [loopControl.create({
        carried: [{ seed, loopInput }],
        body: loopBody
      })]
    }
  };
  const { plan } = place(block);

  deepStrictEqual(plan.values[loopInput], { kind: "loopInput", local: 0 });
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("control outputs and selected results share one planned slot", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const whenTrue = values.const(1);
  const whenFalse = values.const(2);
  const output = values.addNodeOutput();
  const thenBody: Body = { nodes: [], result: whenTrue };
  const elseBody: Body = { nodes: [], result: whenFalse };
  const control = ifControl.create({
    condition,
    output,
    thenBody,
    elseBody
  });
  const block: IrBlock = {
    values,
    body: {
      nodes: [control, resourceWriteNode(values, 0, output)]
    }
  };
  const { analysis, plan } = place(block);
  const controlSite = analysis.siteOf(block.body, 0);

  deepStrictEqual(plan.values[output], {
    kind: "control",
    anchor: controlSite,
    local: 0
  });
});

test("a live join counts an unreachable arm only at its body end", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const unreachable = values.unreachable();
  const fallback = values.const(7);
  const output = values.addNodeOutput();
  const thenBody: Body = { nodes: [], result: unreachable };
  const elseBody: Body = { nodes: [], result: fallback };
  const block: IrBlock = {
    values,
    body: {
      nodes: [ifControl.create({
        condition,
        output,
        thenBody,
        elseBody
      })]
    }
  };
  const { analysis, plan } = place(block, output);

  strictEqual(analysis.useCount(unreachable), 1);
  strictEqual(plan.values[unreachable], undefined);
});

test("nonoverlapping captured values reuse one physical slot", () => {
  const values = compilerTestValues();
  const first = values.addNodeOutput();
  const second = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, first, 0),
        resourceWriteNode(values, 1, first),
        resourceWriteNode(values, 2, first),
        resourceReadNode(values, second, 3),
        resourceWriteNode(values, 4, second),
        resourceWriteNode(values, 5, second)
      ]
    }
  };
  const { plan } = place(block);

  const firstPlacement = plan.values[first];
  const secondPlacement = plan.values[second];

  strictEqual(firstPlacement?.local, secondPlacement?.local);
  deepStrictEqual(plan.localTypes, ["i32"]);
});
