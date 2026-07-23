import { doesNotThrow, throws } from "node:assert";
import { test } from "node:test";

import { CellRef } from "#compiler/ir/cell.js";
import {
  ifControl,
  loopContinueControl,
  loopControl,
  returnControl,
  switchControl,
  type SwitchControlArgs
} from "#compiler/ir/controls/index.js";
import {
  functionType,
  type FunctionGraph,
  type IrFunction
} from "#compiler/ir/function.js";
import { Invocation } from "#compiler/ir/invocation.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
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
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type {
  IntegerWidth,
  ValueId,
  ValueType
} from "#compiler/ir/values/types.js";
import {
  fitsUnsigned,
  signExtended
} from "#compiler/ir/values/width-bounds.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import {
  memoryReadOperation,
  resourceReadNode,
  resourceWriteNode
} from "#test/support/storage-operations.js";

const validationDispatch = testFunctionDefinition(
  "validation.dispatch",
  ["i32"],
  ["i64"]
);
const validationResource = resourceRef("test.validation-resource");

function entryBlock(
  values: ValueTable,
  nodes: readonly RegionNode[]
): FunctionGraph {
  return { values, body: { nodes } };
}

function dispatchReturn(targetEip: ValueId): RegionNode {
  return returnControl.create({
    source: {
      kind: "invocation",
      invocation: Invocation.create({
        target: validationDispatch,
        arguments: [{ value: targetEip, type: "i32" }]
      })
    }
  });
}

function exitReturn(values: ValueTable): RegionNode {
  return returnControl.create({
    source: { kind: "values", values: [values.const64(0n)] }
  });
}

function validateFunctionBlock(
  block: FunctionGraph,
  parameters: readonly ValueId[] = []
): void {
  validateIrFunction({
    ...block,
    type: functionType(
      parameters.map((parameter) => block.values.valueType(parameter)),
      ["i64"]
    ),
    parameters
  });
}

function cellReadNode(output: ValueId, cell: CellRef): RegionNode {
  return cellRead.create({ cell }, () => output);
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

function allocateOutput(
  values: ValueTable
): (result: OperationResult) => ValueId {
  return (result) =>
    result.type === "i64"
      ? values.addNodeOutput64()
      : values.addNodeOutput(result.bounds);
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
  buildOverrides:
    | Partial<SwitchControlArgs>
    | ((values: ValueTable) => Partial<SwitchControlArgs>)
): FunctionGraph {
  const values = new ValueTable();
  const selector = values.const(0);
  const first = values.const(1);
  const second = values.const(2);
  const fallback = values.const(3);
  const overrides =
    typeof buildOverrides === "function"
      ? buildOverrides(values)
      : buildOverrides;
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

test("a nested terminal graph validates", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const target = values.const(0x2000);

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        ifControl.create({
          condition,
          thenBody: { nodes: [dispatchReturn(target)] },
          elseBody: { nodes: [exitReturn(values)] }
        })
      ])
    )
  );
});

test("a returned invocation with matching arguments and results validates", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const target = testFunctionDefinition(
    "validation.return-call",
    ["i32"],
    ["i64"]
  );
  const fn: IrFunction = {
    type: functionType(["i32"], ["i64"]),
    parameters: [argument],
    values,
    body: {
      nodes: [
        returnControl.create({
          source: {
            kind: "invocation",
            invocation: Invocation.create({
              target,
              arguments: [{ value: argument, type: "i32" }]
            })
          }
        })
      ]
    }
  };

  doesNotThrow(() => validateIrFunction(fn));
});

test("a returned invocation must match the enclosing result shape", () => {
  const values = new ValueTable();
  const target = testFunctionDefinition(
    "validation.return-result",
    [],
    ["i64"]
  );
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

  throws(
    () => validateIrFunction(fn),
    /invocation results do not match/
  );
});

test("a returned invocation validates argument value types", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const target = testFunctionDefinition(
    "validation.return-argument",
    ["i64"],
    []
  );
  const fn: IrFunction = {
    type: functionType(["i32"], []),
    parameters: [argument],
    values,
    body: {
      nodes: [
        returnControl.create({
          source: {
            kind: "invocation",
            invocation: Invocation.create({
              target,
              arguments: [{ value: argument, type: "i64" }]
            })
          }
        })
      ]
    }
  };

  throws(() => validateIrFunction(fn), /must be i64, got i32/);
});

test("a terminal control must be the final node in its body", () => {
  const values = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          exitReturn(values),
          resourceWriteNode(values, 0, values.const(1))
        ])
      ),
    /nodes after its terminal return/
  );
});

test("the root body must complete", () => {
  const values = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          resourceWriteNode(values, 0, values.const(1))
        ])
      ),
    /root body does not complete/
  );
});

test("invocation operands must name values in the function table", () => {
  const values = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [dispatchReturn(valueId(99))])
      ),
    /unknown value id/
  );
});

test("operation output bounds must match the declared result", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const output = values.addNodeOutput(fitsUnsigned(8));

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          memoryReadOperation(output, address, 32),
          exitReturn(values)
        ])
      ),
    /wrong bounds/
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

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [read, write, exitReturn(values)])
    )
  );
});

test("resource displacements must be unsigned integers", () => {
  const values = new ValueTable();
  const operation = resourceRead.create(
    {
      source: resourceOperand(
        { basis: { kind: "resource" } },
        values.const(0),
        -1,
        8
      )
    },
    allocateOutput(values)
  );

  throws(
    () =>
      validateFunctionBlock(
        blockWithResourceOperation(values, operation)
      ),
    /displacement must be an unsigned 32-bit integer/
  );
});

test("resource byte slices enforce offset, length, and address-space bounds", () => {
  const cases: readonly [ByteRange, RegExp][] = [
    [
      {
        basis: { kind: "resource" },
        slice: { byteOffset: -1, byteLength: 1 }
      },
      /byte offset/
    ],
    [
      {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 0 }
      },
      /byte length/
    ],
    [
      {
        basis: {
          kind: "dynamic",
          origin: new DynamicByteOriginRef()
        },
        slice: { byteOffset: 0xffff_ffff, byteLength: 2 }
      },
      /range end/
    ]
  ];

  for (const [range, expected] of cases) {
    const values = new ValueTable();
    const operation = resourceRead.create(
      {
        source: resourceOperand(range, values.const(0), 0, 8)
      },
      allocateOutput(values)
    );

    throws(
      () =>
        validateFunctionBlock(
          blockWithResourceOperation(values, operation)
        ),
      expected
    );
  }
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
    () =>
      validateFunctionBlock(
        blockWithResourceOperation(values, operation)
      ),
    /must contain its 32-bit transfer/
  );
});

test("unsigned read refinements must be valid and mechanically possible", () => {
  const validValues = new ValueTable();
  const valid = resourceRead.create(
    {
      source: resourceOperand(
        { basis: { kind: "resource" } },
        validValues.const(0),
        0,
        8
      ),
      mode: { kind: "unsigned", bounds: fitsUnsigned(1) }
    },
    allocateOutput(validValues)
  );

  doesNotThrow(() =>
    validateFunctionBlock(
      blockWithResourceOperation(validValues, valid)
    )
  );

  const wideValues = new ValueTable();
  const tooWide = resourceRead.create(
    {
      source: resourceOperand(
        { basis: { kind: "resource" } },
        wideValues.const(0),
        0,
        8
      ),
      mode: { kind: "unsigned", bounds: fitsUnsigned(16) }
    },
    allocateOutput(wideValues)
  );

  throws(
    () =>
      validateFunctionBlock(
        blockWithResourceOperation(wideValues, tooWide)
      ),
    /bounds exceed/
  );

  const malformedValues = new ValueTable();
  const malformed = resourceRead.create(
    {
      source: resourceOperand(
        { basis: { kind: "resource" } },
        malformedValues.const(0),
        0,
        8
      ),
      mode: {
        kind: "unsigned",
        bounds: { unsignedBits: -1, signedBits: 0 }
      }
    },
    allocateOutput(malformedValues)
  );

  throws(
    () =>
      validateFunctionBlock(
        blockWithResourceOperation(malformedValues, malformed)
      ),
    /bounds are malformed/
  );
});

test("value-producing and control-only switches validate", () => {
  doesNotThrow(() => validateFunctionBlock(switchBlock({})));

  const values = new ValueTable();
  const selection = switchControl.create({
    selector: values.const(0),
    cases: [{ matches: [0, 2], body: { nodes: [] } }],
    defaultBody: { nodes: [] }
  });

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [selection, exitReturn(values)])
    )
  );
});

test("every fallthrough arm of a value-producing switch carries a result", () => {
  throws(
    () =>
      validateFunctionBlock(
        switchBlock({ defaultBody: { nodes: [] } })
      ),
    /must carry a result/
  );
});

test("a control-only switch rejects arm results", () => {
  const values = new ValueTable();
  const selection = switchControl.create({
    selector: values.const(0),
    cases: [
      {
        matches: [0],
        body: { nodes: [], result: values.const(1) }
      }
    ],
    defaultBody: { nodes: [] }
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [selection, exitReturn(values)])
      ),
    /carries a result without an owner output/
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
                result: valueId(1)
              }
            }
          ]
        }))
      ),
    /carries a result but completes/
  );
});

test("switch matches must be unique and within the dense-table range", () => {
  throws(
    () =>
      validateFunctionBlock(
        switchBlock({
          cases: [
            {
              matches: [1],
              body: { nodes: [], result: valueId(1) }
            },
            {
              matches: [1],
              body: { nodes: [], result: valueId(2) }
            }
          ]
        })
      ),
    /duplicate case match/
  );

  throws(
    () =>
      validateFunctionBlock(
        switchBlock({
          cases: [
            {
              matches: [256],
              body: { nodes: [], result: valueId(1) }
            }
          ]
        })
      ),
    /not an integer/
  );
});

test("a seeded cell can be used in a nested descendant", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");
  const seed = values.const(7);
  const output = values.addNodeOutput();
  const body = entryBlock(values, [
    cellWrite.create({
      cell,
      value: seed,
      initialization: "seed"
    }),
    ifControl.create({
      condition: values.const(1),
      thenBody: { nodes: [cellReadNode(output, cell)] }
    }),
    exitReturn(values)
  ]);

  doesNotThrow(() => validateFunctionBlock(body));
});

test("a cell read must follow its seed", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");
  const seed = values.const(7);
  const read = cellReadNode(values.addNodeOutput(), cell);
  const seedNode = cellWrite.create({
    cell,
    value: seed,
    initialization: "seed"
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [read, seedNode, exitReturn(values)])
      ),
    /before its seed/
  );
});

test("a cell has one seed in a function graph", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");
  const seed = values.const(7);
  const first = cellWrite.create({
    cell,
    value: seed,
    initialization: "seed"
  });
  const second = cellWrite.create({
    cell,
    value: seed,
    initialization: "seed"
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [first, second, exitReturn(values)])
      ),
    /seeds the same cell more than once/
  );
});

test("a cell access must have a seed in the same function graph", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          cellReadNode(values.addNodeOutput(), cell),
          exitReturn(values)
        ])
      ),
    /cell with no seed/
  );
});

test("a cell cannot escape its declaring body", () => {
  const values = new ValueTable();
  const cell = new CellRef("i32");
  const seed = values.const(7);
  const branch = ifControl.create({
    condition: values.const(1),
    thenBody: {
      nodes: [
        cellWrite.create({
          cell,
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
          cellReadNode(values.addNodeOutput(), cell),
          exitReturn(values)
        ])
      ),
    /outside its declaring body/
  );
});

test("a carried loop input and aligned continue validate", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const loop = loopControl.create({
    carried: [{ seed, loopInput }],
    body: {
      nodes: [
        loopContinueControl.create({ updates: [loopInput] })
      ]
    }
  });

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [loop, exitReturn(values)])
    )
  );
});

test("loopContinue belongs to a loop and aligns with its carried inputs", () => {
  const outsideValues = new ValueTable();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(outsideValues, [
          loopContinueControl.create({ updates: [] })
        ])
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
    () =>
      validateFunctionBlock(
        entryBlock(values, [loop, exitReturn(values)])
      ),
    /updates do not align/
  );
});

test("a carried loop input must be a loopInput value", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loop = loopControl.create({
    carried: [{ seed, loopInput: seed }],
    body: {
      nodes: [loopContinueControl.create({ updates: [seed] })]
    }
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [loop, exitReturn(values)])
      ),
    /is not a loopInput value/
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
        entryBlock(values, [
          first,
          resourceWriteNode(values, 0, loopInput),
          exitReturn(values)
        ])
      ),
    /outside its owning loop body/
  );

  const second = loopControl.create({
    carried: [{ seed, loopInput }],
    body: { nodes: [] }
  });

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [first, second, exitReturn(values)])
      ),
    /reuses loop input/
  );
});

test("every node output has exactly one producer", () => {
  const missingValues = new ValueTable();

  missingValues.addNodeOutput();
  throws(
    () =>
      validateFunctionBlock(
        entryBlock(missingValues, [exitReturn(missingValues)])
      ),
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

test("producer outputs must name nodeOutput values", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const constant = values.const(1);
  const read = resourceRead.create(
    {
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      ),
      mode: {
        kind: "unsigned",
        bounds: { unsignedBits: 1, signedBits: 2 }
      }
    },
    () => constant
  );

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [read, exitReturn(values)])
      ),
    /is not a nodeOutput value/
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
              nodes: [
                resourceReadNode(
                  siblingValues,
                  siblingOutput,
                  0
                )
              ]
            },
            elseBody: {
              nodes: [
                resourceWriteNode(
                  siblingValues,
                  0,
                  siblingOutput
                )
              ]
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
    () =>
      validateFunctionBlock(
        entryBlock(values, [selection, exitReturn(values)])
      ),
    /created after its output/
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
  const formula = values.binary(
    "add",
    armOutput,
    values.const(1)
  );
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

test("operation operands are allocated before their output", () => {
  const values = new ValueTable();
  const output = values.addNodeOutput();
  const address = values.const(0x2000);

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          memoryReadOperation(output, address, 32),
          exitReturn(values)
        ])
      ),
    /created after its output/
  );
});
