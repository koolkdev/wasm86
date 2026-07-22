import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { testExecutionModel } from "#test/support/execution-model.js";
import { createStatusFlagResolvers } from "#core/flags/lazy/resolvers.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { buildInterpreterProgram } from "#interpreter/program.js";
import type { Body } from "#ir/block.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { SwitchControl } from "#compiler/ir/controls/index.js";
import { placeFunction } from "#compiler/placement/place.js";

let cachedProgram: ReturnType<typeof buildInterpreterProgram> | undefined;

test("interpreter closes as a compiler program with an exact parameterless entry", () => {
  const { program, entry } = interpreterProgram();
  const runExport = program.exports.find(
    (exported) => exported.ref === entry
  );

  ok(runExport !== undefined, "missing exact Interpreter entry export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing interpreter run function declaration");
  deepStrictEqual(run.type.parameters, []);
  deepStrictEqual(run.type.results, ["i64"]);
  ok(program.functionTypes.includes(run.type), "interpreter program must include the run type");
});

test("interpreter links the zero-argument status-flag resolver family", () => {
  const { program } = interpreterProgram();
  const resolverFamily = createStatusFlagResolvers(
    testExecutionModel.cpuState.access
  );
  const expectedResolvers = x86StatusFlags.map((flag) =>
    resolverFamily.get(flag)
  );

  for (const expected of expectedResolvers) {
    const resolver = program.functions.find(
      (fn) => fn.ref.id === expected.ref.id
    );

    ok(resolver !== undefined, `missing status-flag resolver ${expected.ref.id}`);
    strictEqual(resolver.type, expected.type);
    ok(
      program.functionTypes.includes(resolver.type),
      `interpreter program is missing the type for ${expected.ref.id}`
    );
    deepStrictEqual(resolver.type.parameters, []);
    deepStrictEqual(resolver.effects, expected.effects);
  }
});

test("selected ModRM forms own and place their register-index recipes", () => {
  const run = interpreterRun();
  const switches = controls(run.body.body).filter(
    (control): control is SwitchControl => control.kind === "switch"
  );
  const dispatches = switches.flatMap((control) => {
    const modRmByte = modRmByteForFormSelector(
      run.body.values,
      control.selector
    );

    return modRmByte === undefined ? [] : [{
      control,
      cases: control.cases.map((entry) => ({
        body: entry.body,
        indexes: registerIndexes(entry.body, run.body.values, modRmByte)
      })).filter((entry) => entry.indexes.size > 0)
    }];
  });
  const modRmDispatch = dispatches.find((entry) => entry.cases.length >= 2);

  ok(modRmDispatch !== undefined, "expected a ModRM dispatch with multiple register forms");
  const caseIndexes = modRmDispatch.cases.map((entry) => entry.indexes);
  const allIndexes = new Set(caseIndexes.flatMap((ids) => [...ids]));

  strictEqual(
    allIndexes.size,
    caseIndexes.reduce((count, ids) => count + ids.size, 0),
    "register cases must not share independently authored index recipes"
  );

  const placement = placeFunction(run.body);

  for (const entry of modRmDispatch.cases) {
    for (const index of entry.indexes) {
      const planned = placement.plan.values[index];

      ok(planned !== undefined && planned.kind !== "loopInput");
      const site = placement.analysis.sites()[planned.anchor];

      ok(site !== undefined, "register-index recipe has an unknown placement site");
      ok(
        placement.analysis.path(entry.body, site.body) !== undefined,
        "register-index calculation must stay in its selected ModRM case"
      );
    }
  }
});

function modRmByteForFormSelector(
  values: ValueTable,
  selector: ValueId
): ValueId | undefined {
  const masked = values.node(selector);

  if (
    masked.kind !== "binary" ||
    masked.operator !== "and" ||
    values.constValue(masked.b) !== 0b111
  ) {
    return undefined;
  }
  const shifted = values.node(masked.a);

  return shifted.kind === "binary" &&
      shifted.operator === "shr_u" &&
      values.constValue(shifted.b) === 3
    ? shifted.a
    : undefined;
}

function interpreterProgram(): ReturnType<typeof buildInterpreterProgram> {
  cachedProgram ??= buildInterpreterProgram(testExecutionModel);
  return cachedProgram;
}

function interpreterRun() {
  const { program, entry } = interpreterProgram();
  const runExport = program.exports.find(
    (exported) => exported.ref === entry
  );

  ok(runExport !== undefined, "missing exact Interpreter entry export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing compiler IR Interpreter run");
  return run;
}

function controls(body: Body): readonly Body["nodes"][number][] {
  return body.nodes.flatMap((node) => [
    node,
    ...node.nestedBodies.flatMap((nested) => controls(nested.body))
  ]);
}

function registerIndexes(
  body: Body,
  values: ValueTable,
  selector: ValueId
): ReadonlySet<ValueId> {
  const indexes = new Set<ValueId>();
  const visitedWithoutScaledIndex = new Set<ValueId>();
  const visitedWithScaledIndex = new Set<ValueId>();

  function inspect(id: ValueId, throughScaledIndex: boolean): void {
    const visited = throughScaledIndex
      ? visitedWithScaledIndex
      : visitedWithoutScaledIndex;

    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const node = values.node(id);

    if (
      // The shift is the dynamic-GPR array stride. Following this path avoids
      // mistaking unrelated `selector & 7` matches for decoded R/M indexes.
      throughScaledIndex &&
      node.kind === "binary" &&
      node.operator === "and" &&
      node.a === selector &&
      values.constValue(node.b) === 0b111
    ) {
      indexes.add(id);
    }
    const reachesScaledIndex = throughScaledIndex || (
      node.kind === "binary" &&
      node.operator === "shl" &&
      values.constValue(node.b) === 2
    );

    for (const child of values.children(id)) {
      inspect(child, reachesScaledIndex);
    }
  }

  for (const node of controls(body)) {
    for (const operand of node.operands) {
      inspect(operand, false);
    }
  }
  if (body.result !== undefined) {
    inspect(body.result, false);
  }
  return indexes;
}
