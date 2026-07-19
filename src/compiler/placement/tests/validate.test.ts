import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { analyzeBody } from "#compiler/analysis/analyze.js";
import type {
  PlacementPlan,
  ValuePlacement
} from "#compiler/placement/model.js";
import { planPlacement } from "#compiler/placement/plan.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import type { Body, IrBlock } from "#ir/block.js";
import {
  compilerTestValues,
  resourceReadAction,
  resourceWriteAction
} from "#ir/tests/storage-op-helpers.js";

test("accepts condition-frontier and earlier-frontier captures", () => {
  const values = compilerTestValues();
  const quotient = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const firstThen: Body = {
    actions: [resourceWriteAction(values, 0, adjusted)]
  };
  const firstElse: Body = {
    actions: [resourceWriteAction(values, 1, adjusted)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "if",
        condition: quotient,
        thenBody: firstThen,
        elseBody: firstElse
      }]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);

  doesNotThrow(() => validatePlacement(block, analysis, plan));

  const laterValues = compilerTestValues();
  const earlierQuotient = laterValues.binary(
    "div_u",
    laterValues.external(0),
    laterValues.external(1)
  );
  const laterAdjusted = laterValues.binary(
    "add",
    earlierQuotient,
    laterValues.const(1)
  );
  const condition = laterValues.external(2);
  const laterThen: Body = {
    actions: [resourceWriteAction(laterValues, 0, laterAdjusted)]
  };
  const laterElse: Body = {
    actions: [resourceWriteAction(laterValues, 1, laterAdjusted)]
  };
  const laterBlock: IrBlock = {
    values: laterValues,
    body: {
      actions: [
        resourceWriteAction(laterValues, 2, earlierQuotient),
        {
          kind: "if",
          condition,
          thenBody: laterThen,
          elseBody: laterElse
        }
      ]
    }
  };
  const laterAnalysis = analyzeBody(laterBlock);
  const laterPlan = planPlacement(laterBlock, laterAnalysis);

  doesNotThrow(() => validatePlacement(laterBlock, laterAnalysis, laterPlan));
});

test("rejects a raw trapping value hoisted above sibling arms", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const quotient = values.binary(
    "div_u",
    values.external(1),
    values.external(2)
  );
  const thenBody: Body = {
    actions: [resourceWriteAction(values, 0, quotient)]
  };
  const elseBody: Body = {
    actions: [resourceWriteAction(values, 1, quotient)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "if", condition, thenBody, elseBody }]
    }
  };
  const analysis = analyzeBody(block);
  const placements = new Array<ValuePlacement | undefined>(values.size());

  placements[quotient] = {
    kind: "capture",
    anchor: analysis.siteOf(block.body, 0),
    local: 0
  };
  const forged: PlacementPlan = {
    values: placements,
    localTypes: ["i32"],
    cellLocals: new Map()
  };

  throws(
    () => validatePlacement(block, analysis, forged),
    /capture .* may trap/
  );
});

test("rejects at-use placement without a direct demand", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const thenBody: Body = { actions: [resourceWriteAction(values, 0, quotient)] };
  const elseBody: Body = { actions: [resourceWriteAction(values, 1, quotient)] };
  const block: IrBlock = {
    values,
    body: { actions: [{ kind: "if", condition, thenBody, elseBody }] }
  };
  const analysis = analyzeBody(block);
  const placements = new Array<ValuePlacement | undefined>(values.size());

  placements[quotient] = {
    kind: "atUse",
    anchor: analysis.siteOf(block.body, 0),
    local: 0
  };
  throws(
    () => validatePlacement(block, analysis, {
      values: placements,
      localTypes: ["i32"],
      cellLocals: new Map()
    }),
    /at-use value .* has no direct demand/
  );
});

test("rejects a producer anchor before its authored definition", () => {
  const values = compilerTestValues();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceWriteAction(values, 2, values.const(0)),
        resourceReadAction(values, output, 0),
        resourceWriteAction(values, 1, output)
      ]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);
  const placements = [...plan.values];

  placements[output] = {
    kind: "capture",
    anchor: analysis.siteOf(block.body, 0),
    local: plan.localTypes.length
  };

  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      values: placements,
      localTypes: [...plan.localTypes, "i32"]
    }),
    /anchored before its definition/
  );
});

test("rejects an anchor that does not dominate every selected use", () => {
  const values = compilerTestValues();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody: Body = {
    actions: [resourceWriteAction(values, 0, output)]
  };
  const elseBody: Body = {
    actions: [resourceWriteAction(values, 1, output)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceReadAction(values, output, 2),
        { kind: "if", condition, thenBody, elseBody }
      ]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);
  const placements = [...plan.values];

  placements[output] = {
    kind: "atUse",
    anchor: analysis.siteOf(thenBody, 0),
    local: placementLocal(placements[output])
  };

  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      values: placements
    }),
    /anchor does not dominate demand/
  );
});

test("rejects producer movement across an alias but accepts a live snapshot", () => {
  const values = compilerTestValues();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceReadAction(values, output, 0),
        resourceWriteAction(values, 0, values.const(7)),
        resourceWriteAction(values, 1, output)
      ]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);

  doesNotThrow(() => validatePlacement(block, analysis, plan));

  const placements = [...plan.values];

  placements[output] = {
    kind: "atUse",
    anchor: analysis.siteOf(block.body, 2),
    local: undefined
  };

  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      values: placements
    }),
    /crosses an aliasing write/
  );
});

test("rejects overlapping value lifetimes assigned to one local", () => {
  const values = compilerTestValues();
  const first = values.addActionOutput();
  const second = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceReadAction(values, first, 0),
        resourceReadAction(values, second, 3),
        resourceWriteAction(values, 1, first),
        resourceWriteAction(values, 2, second),
        resourceWriteAction(values, 4, first),
        resourceWriteAction(values, 5, second)
      ]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);
  const placements = [...plan.values];

  placements[second] = changeLocal(placements[second], placementLocal(placements[first]));

  throws(
    () => validatePlacement(block, analysis, { ...plan, values: placements }),
    /overlap in local/
  );
});

test("keeps an outer capture live through repeated loop uses", () => {
  const values = compilerTestValues();
  const outer = values.addActionOutput();
  const inner = values.addActionOutput();
  const loopBody: Body = {
    actions: [
      resourceWriteAction(values, 1, outer),
      resourceReadAction(values, inner, 2),
      resourceWriteAction(values, 3, inner),
      resourceWriteAction(values, 4, inner),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        resourceReadAction(values, outer, 0),
        { kind: "loop", carried: [], body: loopBody }
      ]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);

  doesNotThrow(() => validatePlacement(block, analysis, plan));

  const placements = [...plan.values];

  placements[inner] = changeLocal(placements[inner], placementLocal(placements[outer]));
  throws(
    () => validatePlacement(block, analysis, { ...plan, values: placements }),
    /overlap in local/
  );
});

test("rejects hoisting a loop-dependent recipe to the preheader", () => {
  const values = compilerTestValues();
  const loopInput = values.addLoopInput();
  const current = values.binary("add", loopInput, values.const(1));
  const loopBody: Body = {
    actions: [
      resourceWriteAction(values, 0, current),
      { kind: "loopContinue", updates: [loopInput] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{
        kind: "loop",
        carried: [{ seed: values.const(0), loopInput }],
        body: loopBody
      }]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);
  const placements = [...plan.values];

  placements[current] = {
    kind: "capture",
    anchor: analysis.siteOf(block.body, 0),
    local: plan.localTypes.length
  };

  throws(
    () => validatePlacement(block, analysis, {
      ...plan,
      values: placements,
      localTypes: [...plan.localTypes, "i32"]
    }),
    /computed value .* illegal anchor/
  );
});

test("accepts leaving a loop-invariant recipe at its use", () => {
  const values = compilerTestValues();
  const invariant = values.binary("add", values.external(0), values.const(1));
  const loopBody: Body = {
    actions: [
      resourceWriteAction(values, 0, invariant),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [{ kind: "loop", carried: [], body: loopBody }]
    }
  };
  const analysis = analyzeBody(block);
  const plan = planPlacement(block, analysis);
  const placements = [...plan.values];

  placements[invariant] = {
    kind: "atUse",
    anchor: analysis.siteOf(loopBody, 0),
    local: undefined
  };

  doesNotThrow(() => validatePlacement(block, analysis, {
    ...plan,
    values: placements,
    localTypes: []
  }));
});

function placementLocal(placement: ValuePlacement | undefined): number {
  if (placement?.local === undefined) {
    throw new Error("test value has no local");
  }
  return placement.local;
}

function changeLocal(
  placement: ValuePlacement | undefined,
  local: number
): ValuePlacement {
  if (placement === undefined) {
    throw new Error("test value has no placement");
  }
  return { ...placement, local };
}
