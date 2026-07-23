import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { analyzeFunction as runFunctionAnalysis } from "#compiler/analysis/analyze.js";
import {
  ifControl,
  loopContinueControl,
  loopControl
} from "#compiler/ir/controls/index.js";
import type { ValuePlacement } from "#compiler/placement/model.js";
import { planPlacement } from "#compiler/placement/plan.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import type { Region } from "#compiler/ir/region.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import {
  compilerTestValues,
  resourceReadNode,
  resourceWriteNode
} from "#test/support/storage-operations.js";
import { completedPlacementFunction } from "./function-fixture.js";

function analyzeFunction(block: FunctionGraph, parameterCount = 0) {
  const fn = completedPlacementFunction(block, parameterCount);

  return {
    fn,
    analysis: runFunctionAnalysis(fn)
  };
}

test("accepts condition-frontier and earlier-frontier captures", () => {
  const values = compilerTestValues();
  const quotient = values.binary(
    "div_u",
    values.parameter(0, "i32"),
    values.parameter(1, "i32")
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const firstThen: Region = {
    nodes: [resourceWriteNode(values, 0, adjusted)]
  };
  const firstElse: Region = {
    nodes: [resourceWriteNode(values, 1, adjusted)]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [ifControl.create({
        condition: quotient,
        thenBody: firstThen,
        elseBody: firstElse
      })]
    }
  };
  const { fn, analysis } = analyzeFunction(block, 2);
  const plan = planPlacement(fn, analysis);

  doesNotThrow(() => validatePlacement(fn, analysis, plan));

  const laterValues = compilerTestValues();
  const earlierQuotient = laterValues.binary(
    "div_u",
    laterValues.parameter(0, "i32"),
    laterValues.parameter(1, "i32")
  );
  const laterAdjusted = laterValues.binary(
    "add",
    earlierQuotient,
    laterValues.const(1)
  );
  const condition = laterValues.parameter(2, "i32");
  const laterThen: Region = {
    nodes: [resourceWriteNode(laterValues, 0, laterAdjusted)]
  };
  const laterElse: Region = {
    nodes: [resourceWriteNode(laterValues, 1, laterAdjusted)]
  };
  const laterBlock: FunctionGraph = {
    values: laterValues,
    body: {
      nodes: [
        resourceWriteNode(laterValues, 2, earlierQuotient),
        ifControl.create({
          condition,
          thenBody: laterThen,
          elseBody: laterElse
        })
      ]
    }
  };
  const { fn: laterFn, analysis: laterAnalysis } = analyzeFunction(laterBlock, 3);
  const laterPlan = planPlacement(laterFn, laterAnalysis);

  doesNotThrow(() => validatePlacement(laterFn, laterAnalysis, laterPlan));
});

test("rejects a producer anchor before its authored definition", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceWriteNode(values, 2, values.const(0)),
        resourceReadNode(values, output, 0),
        resourceWriteNode(values, 1, output)
      ]
    }
  };
  const { fn, analysis } = analyzeFunction(block);
  const plan = planPlacement(fn, analysis);
  const placements = [...plan.values];

  placements[output] = {
    kind: "capture",
    anchor: analysis.siteOf(fn.body, 0),
    local: plan.localTypes.length
  };

  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      values: placements,
      localTypes: [...plan.localTypes, "i32"]
    }),
    /anchored before its definition/
  );
});

test("rejects an anchor that does not dominate every selected use", () => {
  const values = compilerTestValues();
  const condition = values.parameter(0, "i32");
  const output = values.addNodeOutput();
  const thenBody: Region = {
    nodes: [resourceWriteNode(values, 0, output)]
  };
  const elseBody: Region = {
    nodes: [resourceWriteNode(values, 1, output)]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 2),
        ifControl.create({ condition, thenBody, elseBody })
      ]
    }
  };
  const { fn, analysis } = analyzeFunction(block, 1);
  const plan = planPlacement(fn, analysis);
  const placements = [...plan.values];

  placements[output] = {
    kind: "atUse",
    anchor: analysis.siteOf(thenBody, 0),
    local: placementLocal(placements[output])
  };

  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      values: placements
    }),
    /anchor does not dominate demand/
  );
});

test("rejects producer movement across an alias but accepts a live snapshot", () => {
  const values = compilerTestValues();
  const output = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, output, 0),
        resourceWriteNode(values, 0, values.const(7)),
        resourceWriteNode(values, 1, output)
      ]
    }
  };
  const { fn, analysis } = analyzeFunction(block);
  const plan = planPlacement(fn, analysis);

  doesNotThrow(() => validatePlacement(fn, analysis, plan));

  const placements = [...plan.values];

  placements[output] = {
    kind: "atUse",
    anchor: analysis.siteOf(fn.body, 2),
    local: undefined
  };

  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      values: placements
    }),
    /crosses an aliasing write/
  );
});

test("rejects overlapping value lifetimes assigned to one local", () => {
  const values = compilerTestValues();
  const first = values.addNodeOutput();
  const second = values.addNodeOutput();
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, first, 0),
        resourceReadNode(values, second, 3),
        resourceWriteNode(values, 1, first),
        resourceWriteNode(values, 2, second),
        resourceWriteNode(values, 4, first),
        resourceWriteNode(values, 5, second)
      ]
    }
  };
  const { fn, analysis } = analyzeFunction(block);
  const plan = planPlacement(fn, analysis);
  const placements = [...plan.values];

  placements[second] = changeLocal(placements[second], placementLocal(placements[first]));

  throws(
    () => validatePlacement(fn, analysis, { ...plan, values: placements }),
    /overlap in local/
  );
});

test("keeps an outer capture live through repeated loop uses", () => {
  const values = compilerTestValues();
  const outer = values.addNodeOutput();
  const inner = values.addNodeOutput();
  const loopBody: Region = {
    nodes: [
      resourceWriteNode(values, 1, outer),
      resourceReadNode(values, inner, 2),
      resourceWriteNode(values, 3, inner),
      resourceWriteNode(values, 4, inner),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [
        resourceReadNode(values, outer, 0),
        loopControl.create({ carried: [], body: loopBody })
      ]
    }
  };
  const { fn, analysis } = analyzeFunction(block);
  const plan = planPlacement(fn, analysis);

  doesNotThrow(() => validatePlacement(fn, analysis, plan));

  const placements = [...plan.values];

  placements[inner] = changeLocal(placements[inner], placementLocal(placements[outer]));
  throws(
    () => validatePlacement(fn, analysis, { ...plan, values: placements }),
    /overlap in local/
  );
});

test("rejects hoisting a loop-dependent recipe to the preheader", () => {
  const values = compilerTestValues();
  const loopInput = values.addLoopInput();
  const current = values.binary("add", loopInput, values.const(1));
  const loopBody: Region = {
    nodes: [
      resourceWriteNode(values, 0, current),
      loopContinueControl.create({ updates: [loopInput] })
    ]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [loopControl.create({
        carried: [{ seed: values.const(0), loopInput }],
        body: loopBody
      })]
    }
  };
  const { fn, analysis } = analyzeFunction(block);
  const plan = planPlacement(fn, analysis);
  const placements = [...plan.values];

  placements[current] = {
    kind: "capture",
    anchor: analysis.siteOf(fn.body, 0),
    local: plan.localTypes.length
  };

  throws(
    () => validatePlacement(fn, analysis, {
      ...plan,
      values: placements,
      localTypes: [...plan.localTypes, "i32"]
    }),
    /computed value .* illegal anchor/
  );
});

test("accepts leaving a loop-invariant recipe at its use", () => {
  const values = compilerTestValues();
  const invariant = values.binary("add", values.parameter(0, "i32"), values.const(1));
  const loopBody: Region = {
    nodes: [
      resourceWriteNode(values, 0, invariant),
      loopContinueControl.create({ updates: [] })
    ]
  };
  const block: FunctionGraph = {
    values,
    body: {
      nodes: [loopControl.create({ carried: [], body: loopBody })]
    }
  };
  const { fn, analysis } = analyzeFunction(block, 1);
  const plan = planPlacement(fn, analysis);
  const placements = [...plan.values];

  placements[invariant] = {
    kind: "atUse",
    anchor: analysis.siteOf(loopBody, 0),
    local: undefined
  };

  doesNotThrow(() => validatePlacement(fn, analysis, {
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
