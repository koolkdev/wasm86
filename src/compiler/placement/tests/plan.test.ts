import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { placeBody } from "#compiler/placement/place.js";
import type { Body, IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import {
  memoryWrite,
  stateRead,
  stateWrite
} from "#ir/tests/storage-op-helpers.js";

function place(block: IrBlock, exportedOutputs: readonly ValueId[] = []) {
  return placeBody(block, {
    exportedOutputs,
    allowImplicitEntryFallthrough: true
  });
}

test("a producer used only in a selected body realizes at that use", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), output)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "if", condition, thenBody }
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
  const values = new ValueTable();
  const condition = values.external(0);
  const result = values.binary("add", values.external(1), values.const(1));
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), result)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "if", condition, thenBody }]
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

test("a recipe shared with parent flow anchors at the common dominator", () => {
  const values = new ValueTable();
  const shared = values.binary("add", values.external(0), values.const(1));
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), shared)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "if", condition: shared, thenBody }]
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

test("an exit result is placed at its selected finish", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const payload = values.external(1);
  const result = values.binary64(
    "or",
    values.extend64(32, payload, false),
    values.const64(0x1200n)
  );
  const thenBody: Body = {
    actions: [{ kind: "finish", finish: { kind: "exit", result } }]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "if", condition, thenBody }]
    }
  };
  const { analysis, plan } = place(block);
  const finishSite = analysis.siteOf(thenBody, 0);

  deepStrictEqual(plan.values[result], {
    kind: "atUse",
    anchor: finishSite,
    local: undefined
  });
  deepStrictEqual(plan.localTypes, []);
});

test("an aliasing write captures a producer at its authored site", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), values.const(5)),
      stateWrite(gprChannel("ebx"), output)
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "if", condition, thenBody }
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
  const values = new ValueTable();
  const address = values.external(0);
  const base = values.external(1);
  const increment = values.const(1);
  const byteLength = values.binary("add", base, increment);
  const write = memoryWrite(address, byteLength, 32);
  const block: IrBlock = {
    values,
    body: { actions: [write] }
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
  const values = new ValueTable();
  const output = values.addActionOutput();
  const loopInput = values.addLoopInput();
  const loopBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), output)]
  };
  const loop = {
    kind: "loop",
    carried: [{ channel: gprChannel("eax"), seed: output, loopInput }],
    body: loopBody
  } as const;
  const block: IrBlock = {
    values,
    body: { actions: [stateRead(output, gprChannel("eax")), loop] }
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
  const values = new ValueTable();
  const invariant = values.binary("add", values.external(0), values.const(1));
  const loopBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), invariant),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const loopInput = values.addLoopInput();
  const current = values.binary("add", loopInput, values.const(1));
  const loopBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), current),
      { kind: "loopContinue", updates: [loopInput] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "loop",
        carried: [{ channel: gprChannel("eax"), seed: values.const(0), loopInput }],
        body: loopBody
      }]
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
  const values = new ValueTable();
  const output = values.addActionOutput();
  const current = values.binary("add", output, values.const(1));
  const loopBody: Body = {
    actions: [
      stateRead(output, gprChannel("eax")),
      stateWrite(gprChannel("ebx"), current),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const condition = values.external(0);
  const whenTrue = values.const(1);
  const whenFalse = values.const(2);
  const selected = values.addActionOutput();
  const current = values.binary("add", selected, values.const(1));
  const loopBody: Body = {
    actions: [
      {
        kind: "if",
        condition,
        output: selected,
        thenBody: { actions: [], result: whenTrue },
        elseBody: { actions: [], result: whenFalse }
      },
      stateWrite(gprChannel("eax"), current),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const quotient = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const loopBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), adjusted),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const condition = values.external(0);
  const invariant = values.binary("add", values.external(1), values.const(1));
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), invariant)]
  };
  const loopBody: Body = {
    actions: [
      { kind: "if", condition, thenBody },
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const invariant = values.binary("add", values.external(1), values.const(1));
  const loopBody: Body = {
    actions: [
      {
        kind: "if",
        condition: values.external(0),
        thenBody: {
          actions: [stateWrite(gprChannel("eax"), invariant)]
        },
        elseBody: {
          actions: [stateWrite(gprChannel("ebx"), invariant)]
        }
      },
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
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
  const values = new ValueTable();
  const outerInput = values.addLoopInput();
  const current = values.binary("add", outerInput, values.const(1));
  const innerBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), current),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const outerBody: Body = {
    actions: [
      { kind: "loop", carried: [], body: innerBody },
      { kind: "loopContinue", updates: [outerInput] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "loop",
        carried: [{ channel: gprChannel("eax"), seed: values.const(0), loopInput: outerInput }],
        body: outerBody
      }]
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
  const values = new ValueTable();
  const invariant = values.binary("add", values.external(0), values.const(1));
  const innerBody: Body = {
    actions: [
      stateWrite(gprChannel("eax"), invariant),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const outerBody: Body = {
    actions: [
      { kind: "loop", carried: [], body: innerBody },
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: outerBody }]
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
  const values = new ValueTable();
  const output = values.addActionOutput();
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), output)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "if", condition: output, thenBody }
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
  const values = new ValueTable();
  const quotient = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), adjusted)]
  };
  const elseBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), adjusted)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition: quotient,
        thenBody,
        elseBody
      }]
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
  const values = new ValueTable();
  const unreachable = values.unreachable();
  const wrapped = values.unary("eqz", unreachable);
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), wrapped)]
  };
  const elseBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), wrapped)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition: unreachable,
        thenBody,
        elseBody
      }]
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
  const values = new ValueTable();
  const quotient = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const condition = values.external(2);
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), adjusted)]
  };
  const elseBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), adjusted)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateWrite(gprChannel("ecx"), quotient),
        { kind: "if", condition, thenBody, elseBody }
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
  const values = new ValueTable();
  const selector = values.external(0);
  const quotient = values.binary(
    "div_u",
    values.external(1),
    values.external(2)
  );
  const fallback = values.const(7);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            { match: 0, body: { actions: [], result: quotient } },
            { match: 1, body: { actions: [], result: quotient } }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };

  throws(
    () => place(block),
    /trapping value .* has no legal capture deadline/
  );
});

test("a loop input carries its local without an evaluation anchor", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();
  const loopBody: Body = {
    actions: [{ kind: "loopContinue", updates: [loopInput] }]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "loop",
        carried: [{ channel: gprChannel("eax"), seed, loopInput }],
        body: loopBody
      }]
    }
  };
  const { plan } = place(block);

  deepStrictEqual(plan.values[loopInput], { kind: "loopInput", local: 0 });
  deepStrictEqual(plan.localTypes, ["i32"]);
});

test("control outputs and selected results share one planned slot", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const whenTrue = values.const(1);
  const whenFalse = values.const(2);
  const output = values.addActionOutput();
  const thenBody: Body = { actions: [], result: whenTrue };
  const elseBody: Body = { actions: [], result: whenFalse };
  const control = {
    kind: "if",
    condition,
    output,
    thenBody,
    elseBody
  } as const;
  const block: IrBlock = {
    values,
    body: {
      actions: [control, stateWrite(gprChannel("eax"), output)]
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
  const values = new ValueTable();
  const condition = values.external(0);
  const unreachable = values.unreachable();
  const fallback = values.const(7);
  const output = values.addActionOutput();
  const thenBody: Body = { actions: [], result: unreachable };
  const elseBody: Body = { actions: [], result: fallback };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition,
        output,
        thenBody,
        elseBody
      }]
    }
  };
  const { analysis, plan } = place(block, [output]);

  strictEqual(analysis.useCount(unreachable), 1);
  strictEqual(plan.values[unreachable], undefined);
});

test("nonoverlapping captured values reuse one physical slot", () => {
  const values = new ValueTable();
  const first = values.addActionOutput();
  const second = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(first, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), first),
        stateWrite(gprChannel("ecx"), first),
        stateRead(second, gprChannel("edx")),
        stateWrite(gprChannel("esi"), second),
        stateWrite(gprChannel("edi"), second)
      ]
    }
  };
  const { plan } = place(block);

  const firstPlacement = plan.values[first];
  const secondPlacement = plan.values[second];

  strictEqual(firstPlacement?.local, secondPlacement?.local);
  deepStrictEqual(plan.localTypes, ["i32"]);
});
