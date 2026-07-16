import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/program/function-type.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { Action } from "./actions.js";
import type { Body } from "./block.js";
import { BodyBuilder } from "./body-builder.js";

export type IrFunction = Readonly<{
  type: FunctionType;
  parameters: readonly ValueId[];
  body: Body;
  values: ValueTable;
}>;

export class FunctionBuilder {
  readonly values = new ValueTable();
  readonly body = new BodyBuilder(this.values);
  readonly parameters: readonly ValueId[];
  readonly #type: FunctionType;
  #finished = false;

  constructor(type: FunctionType) {
    assert(
      type.results.length <= 1,
      `functions with ${type.results.length} results are not supported yet`
    );
    this.#type = type;
    this.parameters = type.parameters.map((parameterType, index) =>
      this.values.parameter(index, parameterType)
    );
  }

  return(results: readonly ValueId[]): void {
    this.body.return(results);
  }

  finish(): IrFunction {
    assert(!this.#finished, "cannot finish a function twice");
    this.#finished = true;
    return {
      type: this.#type,
      parameters: [...this.parameters],
      body: snapshotBody(this.body.build()),
      values: this.values.fork()
    };
  }
}

export function buildFunction(
  type: FunctionType,
  build: (fn: FunctionBuilder) => void
): IrFunction {
  const fn = new FunctionBuilder(type);

  build(fn);
  return fn.finish();
}

function snapshotBody(body: Body): Body {
  const actions = body.actions.map(snapshotAction);

  return body.result === undefined ? { actions } : { actions, result: body.result };
}

function snapshotAction(action: Action): Action {
  switch (action.kind) {
    case "if":
      return action.elseBody === undefined
        ? { ...action, thenBody: snapshotBody(action.thenBody) }
        : {
            ...action,
            thenBody: snapshotBody(action.thenBody),
            elseBody: snapshotBody(action.elseBody)
          };
    case "switch":
      return {
        ...action,
        cases: action.cases.map((entry) => ({
          match: entry.match,
          body: snapshotBody(entry.body)
        })),
        defaultBody: snapshotBody(action.defaultBody)
      };
    case "loop":
      return { ...action, body: snapshotBody(action.body) };
    case "op":
    case "call":
    case "loopContinue":
    case "finish":
    case "return":
      return action;
  }
}
