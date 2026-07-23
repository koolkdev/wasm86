import { deepStrictEqual, ok } from "node:assert";
import { test } from "node:test";

import { testExecutionModel } from "#test/support/execution-model.js";
import { buildInterpreterProgram } from "#interpreter/program.js";

test("interpreter program exposes a parameterless i64 entry", () => {
  const { program, entry } = buildInterpreterProgram(testExecutionModel);
  const runExport = program.exports.find(
    (exported) => exported.ref === entry
  );

  ok(runExport !== undefined, "missing Interpreter entry export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing interpreter run function declaration");
  deepStrictEqual(run.type.parameters, []);
  deepStrictEqual(run.type.results, ["i64"]);
  ok(program.functionTypes.includes(run.type), "interpreter program must include the run type");
});
