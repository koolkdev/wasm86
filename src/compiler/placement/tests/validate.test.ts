import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { analyzeBody } from "#compiler/analysis/analyze.js";
import type {
  PlacementPlan,
  ValuePlacement
} from "#compiler/placement/model.js";
import { planPlacement } from "#compiler/placement/plan.js";
import { validatePlacement } from "#compiler/placement/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { Body, IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

test("accepts condition-frontier and earlier-frontier captures", () => {
  const values = new ValueTable();
  const quotient = values.binary(
    "div_u",
    values.external(0),
    values.external(1)
  );
  const adjusted = values.binary("add", quotient, values.const(1));
  const firstThen: Body = {
    actions: [stateWrite(gprChannel("eax"), adjusted)]
  };
  const firstElse: Body = {
    actions: [stateWrite(gprChannel("ebx"), adjusted)]
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

  const laterValues = new ValueTable();
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
    actions: [stateWrite(gprChannel("eax"), laterAdjusted)]
  };
  const laterElse: Body = {
    actions: [stateWrite(gprChannel("ebx"), laterAdjusted)]
  };
  const laterBlock: IrBlock = {
    values: laterValues,
    body: {
      actions: [
        stateWrite(gprChannel("ecx"), earlierQuotient),
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
  const values = new ValueTable();
  const condition = values.external(0);
  const quotient = values.binary(
    "div_u",
    values.external(1),
    values.external(2)
  );
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), quotient)]
  };
  const elseBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), quotient)]
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
    variableLocals: []
  };

  throws(
    () => validatePlacement(block, analysis, forged),
    /capture .* may trap/
  );
});

test("rejects at-use placement without a direct demand", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const quotient = values.binary("div_u", values.external(1), values.external(2));
  const thenBody: Body = { actions: [stateWrite(gprChannel("eax"), quotient)] };
  const elseBody: Body = { actions: [stateWrite(gprChannel("ebx"), quotient)] };
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
      variableLocals: []
    }),
    /at-use value .* has no direct demand/
  );
});

test("rejects a producer anchor before its authored definition", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateWrite(gprChannel("ecx"), values.const(0)),
        stateRead(output, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), output)
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
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody: Body = {
    actions: [stateWrite(gprChannel("eax"), output)]
  };
  const elseBody: Body = {
    actions: [stateWrite(gprChannel("ebx"), output)]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("ecx")),
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
  const values = new ValueTable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        stateWrite(gprChannel("eax"), values.const(7)),
        stateWrite(gprChannel("ebx"), output)
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
  const values = new ValueTable();
  const first = values.addActionOutput();
  const second = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(first, gprChannel("eax")),
        stateRead(second, gprChannel("edx")),
        stateWrite(gprChannel("ebx"), first),
        stateWrite(gprChannel("ecx"), second),
        stateWrite(gprChannel("esi"), first),
        stateWrite(gprChannel("edi"), second)
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
  const values = new ValueTable();
  const outer = values.addActionOutput();
  const inner = values.addActionOutput();
  const loopBody: Body = {
    actions: [
      stateWrite(gprChannel("ebx"), outer),
      stateRead(inner, gprChannel("ecx")),
      stateWrite(gprChannel("edx"), inner),
      stateWrite(gprChannel("esi"), inner),
      { kind: "loopContinue", updates: [] }
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(outer, gprChannel("eax")),
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
