import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { VariableRef } from "#compiler/ir/variable.js";
import {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl,
  type SwitchControlArgs
} from "#compiler/ir/controls/index.js";
import { functionType, type FunctionGraph, type IrFunction } from "#compiler/ir/function.js";
import { Invocation } from "#compiler/ir/invocation.js";
import { variableRead, variableWrite } from "#compiler/ir/operations/variables.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import {
  resourceRead,
  resourceWrite,
  type ResourceOperation
} from "#compiler/ir/operations/resource.js";
import type { Region, RegionNode } from "#compiler/ir/region.js";
import { functionRef } from "#compiler/ir/refs.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand
} from "#compiler/ir/resource.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { IntegerWidth, ValueId, ValueType } from "#compiler/ir/values/types.js";
import { signExtended } from "#compiler/ir/values/width-bounds.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { resourceReadNode, resourceWriteNode } from "#test/support/storage-operations.js";

const validationResource = resourceRef("test.validation-resource");

function entryBlock(values: ValueTable, nodes: readonly RegionNode[]): FunctionGraph {
  return { values, body: { nodes } };
}

function exitReturn(values: ValueTable): RegionNode {
  return returnControl.create({
    source: { kind: "values", values: [values.const64(0n)] }
  });
}

function validateFunctionBlock(block: FunctionGraph, parameters: readonly ValueId[] = []): void {
  validateIrFunction({
    ...block,
    type: functionType(
      parameters.map((parameter) => block.values.valueType(parameter)),
      ["i64"]
    ),
    parameters
  });
}

function variableReadNode(output: ValueId, variable: VariableRef): RegionNode {
  return variableRead.create({ variable }, () => output);
}

function resourceOperand(
  range: ByteRange,
  base: ValueId,
  displacement: number,
  width: IntegerWidth
): ResourceByteOperand {
  return {
    effect: {
      space: "resource",
      resource: validationResource,
      range
    },
    address: { base, displacement },
    width
  };
}

function allocateOutput(values: ValueTable): (result: OperationResult) => ValueId {
  return (result) =>
    result.type === "i64" ? values.addNodeOutput64() : values.addNodeOutput(result.bounds);
}

function blockWithResourceOperation(
  values: ValueTable,
  operation: ResourceOperation
): FunctionGraph {
  return entryBlock(values, [operation, exitReturn(values)]);
}

function testFunctionDefinition(
  id: string,
  parameters: readonly ValueType[],
  results: readonly ValueType[]
): FunctionDefinition {
  return new FunctionDefinition({
    ref: functionRef(id),
    type: functionType(parameters, results),
    effects: { reads: [], writes: [] },
    owner: undefined,
    build: () => {}
  });
}

function switchBlock(
  buildOverrides: Partial<SwitchControlArgs> | ((values: ValueTable) => Partial<SwitchControlArgs>)
): FunctionGraph {
  const values = new ValueTable();
  const selector = values.const(0);
  const first = values.const(1);
  const second = values.const(2);
  const fallback = values.const(3);
  const overrides = typeof buildOverrides === "function" ? buildOverrides(values) : buildOverrides;
  const selection = switchControl.create({
    selector,
    output: values.addNodeOutput(),
    cases: [
      { matches: [0], body: { nodes: [], result: first } },
      { matches: [2], body: { nodes: [], result: second } }
    ],
    defaultBody: { nodes: [], result: fallback },
    ...overrides
  });

  return entryBlock(values, [selection, exitReturn(values)]);
}

test("a returned invocation must match the enclosing result shape", () => {
  const values = new ValueTable();
  const target = testFunctionDefinition("validation.return-result", [], ["i64"]);
  const fn: IrFunction = {
    type: functionType([], ["i32"]),
    parameters: [],
    values,
    body: {
      nodes: [
        returnControl.create({
          source: {
            kind: "invocation",
            invocation: Invocation.create({ target, arguments: [] })
          }
        })
      ]
    }
  };

  throws(() => validateIrFunction(fn), /invocation results do not match/);
});

test("a terminal control must be the final node in its body", () => {
  const values = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [exitReturn(values), resourceWriteNode(values, 0, values.const(1))])
      ),
    /nodes after its terminal return/
  );
});

test("the root body must complete", () => {
  const values = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(entryBlock(values, [resourceWriteNode(values, 0, values.const(1))])),
    /root body does not complete/
  );
});

test("valid narrow resource operations and conservative slices validate", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const value = values.const(0x1234);
  const range: ByteRange = {
    basis: {
      kind: "dynamic",
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 4, byteLength: 4 }
  };
  const read = resourceRead.create(
    {
      source: resourceOperand(range, address, 4, 16),
      mode: { kind: "signed" }
    },
    () => values.addNodeOutput(signExtended(16))
  );
  const write = resourceWrite.create({
    destination: resourceOperand(range, address, 4, 16),
    value
  });

  doesNotThrow(() => validateFunctionBlock(entryBlock(values, [read, write, exitReturn(values)])));
});

test("a resource slice must contain its transfer", () => {
  const values = new ValueTable();
  const operation = resourceRead.create(
    {
      source: resourceOperand(
        {
          basis: { kind: "resource" },
          slice: { byteOffset: 0, byteLength: 1 }
        },
        values.const(0),
        0,
        32
      )
    },
    allocateOutput(values)
  );

  throws(
    () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
    /must contain its 32-bit transfer/
  );
});

test("a completing arm cannot also carry a result", () => {
  throws(
    () =>
      validateFunctionBlock(
        switchBlock((values) => ({
          cases: [
            {
              matches: [0],
              body: {
                nodes: [exitReturn(values)],
                result: values.const(4)
              }
            }
          ]
        }))
      ),
    /carries a result but completes/
  );
});

test("a variable read must follow its seed", () => {
  const values = new ValueTable();
  const variable = new VariableRef("i32");
  const seed = values.const(7);
  const read = variableReadNode(values.addNodeOutput(), variable);
  const seedNode = variableWrite.create({
    variable,
    value: seed,
    initialization: "seed"
  });

  throws(
    () => validateFunctionBlock(entryBlock(values, [read, seedNode, exitReturn(values)])),
    /before its seed/
  );
});

test("a variable has one seed in a function graph", () => {
  const values = new ValueTable();
  const variable = new VariableRef("i32");
  const seed = values.const(7);
  const first = variableWrite.create({
    variable,
    value: seed,
    initialization: "seed"
  });
  const second = variableWrite.create({
    variable,
    value: seed,
    initialization: "seed"
  });

  throws(
    () => validateFunctionBlock(entryBlock(values, [first, second, exitReturn(values)])),
    /seeds the same variable more than once/
  );
});

test("a variable access must have a seed in the same function graph", () => {
  const values = new ValueTable();
  const variable = new VariableRef("i32");

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [variableReadNode(values.addNodeOutput(), variable), exitReturn(values)])
      ),
    /variable with no seed/
  );
});

test("a variable cannot escape its declaring body", () => {
  const values = new ValueTable();
  const variable = new VariableRef("i32");
  const seed = values.const(7);
  const branch = ifControl.create({
    condition: values.const(1),
    thenBody: {
      nodes: [
        variableWrite.create({
          variable,
          value: seed,
          initialization: "seed"
        })
      ]
    }
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          branch,
          variableReadNode(values.addNodeOutput(), variable),
          exitReturn(values)
        ])
      ),
    /outside its declaring body/
  );
});

test("loopContinue belongs to a loop and aligns with its carried inputs", () => {
  const outsideValues = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(outsideValues, [loopContinueControl.create({ updates: [] })])
      ),
    /outside any loop body/
  );

  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const loop = loopControl.create({
    carried: [{ seed, loopInput }],
    body: {
      nodes: [loopContinueControl.create({ updates: [] })]
    }
  });

  throws(
    () => validateFunctionBlock(entryBlock(values, [loop, exitReturn(values)])),
    /updates do not align/
  );
});

test("a loop input is scoped to one owning loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();
  const first = loopControl.create({
    carried: [{ seed, loopInput }],
    body: { nodes: [] }
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [first, resourceWriteNode(values, 0, loopInput), exitReturn(values)])
      ),
    /outside its owning loop body/
  );

  const second = loopControl.create({
    carried: [{ seed, loopInput }],
    body: { nodes: [] }
  });

  throws(
    () => validateFunctionBlock(entryBlock(values, [first, second, exitReturn(values)])),
    /reuses loop input/
  );
});

test("every node output has exactly one producer", () => {
  const missingValues = new ValueTable();

  missingValues.addNodeOutput();
  throws(
    () => validateFunctionBlock(entryBlock(missingValues, [exitReturn(missingValues)])),
    /has no producer/
  );

  const duplicateValues = new ValueTable();
  duplicateValues.const(0);
  const output = duplicateValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(duplicateValues, [
          resourceReadNode(duplicateValues, output, 0),
          resourceReadNode(duplicateValues, output, 0),
          exitReturn(duplicateValues)
        ])
      ),
    /more than one producer/
  );
});

test("a producer must dominate same-body and sibling-body uses", () => {
  const directValues = new ValueTable();
  directValues.const(0);
  const directOutput = directValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(directValues, [
          resourceWriteNode(directValues, 0, directOutput),
          resourceReadNode(directValues, directOutput, 0),
          exitReturn(directValues)
        ])
      ),
    /does not dominate/
  );

  const siblingValues = new ValueTable();
  const condition = siblingValues.const(1);
  siblingValues.const(0);
  const siblingOutput = siblingValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(siblingValues, [
          ifControl.create({
            condition,
            thenBody: {
              nodes: [resourceReadNode(siblingValues, siblingOutput, 0)]
            },
            elseBody: {
              nodes: [resourceWriteNode(siblingValues, 0, siblingOutput)]
            }
          }),
          exitReturn(siblingValues)
        ])
      ),
    /does not dominate/
  );
});

test("one Region object has one control owner", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const shared: Region = { nodes: [] };

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          ifControl.create({ condition, thenBody: shared }),
          ifControl.create({ condition, thenBody: shared }),
          exitReturn(values)
        ])
      ),
    /reuses a Region object/
  );
});

test("a control output cannot depend on itself", () => {
  const values = new ValueTable();
  const result = values.const(1);
  const output = values.addNodeOutput();
  const selection = switchControl.create({
    selector: output,
    output,
    cases: [{ matches: [0], body: { nodes: [], result } }],
    defaultBody: { nodes: [], result }
  });

  throws(
    () => validateFunctionBlock(entryBlock(values, [selection, exitReturn(values)])),
    /does not dominate/
  );
});

test("valid control outputs and ancestor producers dominate later uses", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const fallback = values.const(1);
  const source = values.addNodeOutput();
  const selectionOutput = values.addNodeOutput();

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        resourceReadNode(values, source, 0),
        ifControl.create({
          condition: selector,
          thenBody: {
            nodes: [resourceWriteNode(values, 0, source)]
          }
        }),
        switchControl.create({
          selector,
          output: selectionOutput,
          cases: [
            {
              matches: [0],
              body: { nodes: [], result: source }
            }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        resourceWriteNode(values, 0, selectionOutput),
        exitReturn(values)
      ])
    )
  );
});

test("a body-local producer can feed its body result", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const fallback = values.const(7);
  const armOutput = values.addNodeOutput();
  const formula = values.binary("add", armOutput, values.const(1));
  const selectionOutput = values.addNodeOutput();

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        switchControl.create({
          selector,
          output: selectionOutput,
          cases: [
            {
              matches: [0],
              body: {
                nodes: [resourceReadNode(values, armOutput, 0)],
                result: formula
              }
            }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        exitReturn(values)
      ])
    )
  );
});
