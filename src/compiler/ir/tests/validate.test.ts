import { doesNotThrow, ok, throws } from "node:assert";
import { test } from "node:test";

import {
  ifControl,
  loopContinueControl,
  loopControl,
  maxSwitchMatch,
  returnControl,
  switchControl,
  type SwitchControl,
  type SwitchControlArgs
} from "#compiler/ir/controls/index.js";
import { Invocation } from "#compiler/ir/invocation.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import type { RegionNode, Region } from "#compiler/ir/region.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { FunctionGraph, IrFunction } from "#compiler/ir/function.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import { CellRef } from "#compiler/ir/cell.js";
import { cellRead, cellWrite } from "#compiler/ir/operations/cells.js";
import {
  resourceRead,
  resourceWrite,
  type ResourceOperation
} from "#compiler/ir/operations/resource.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceRef
} from "#compiler/ir/resource.js";
import {
  fitsUnsigned,
  signExtended
} from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type {
  IntegerWidth,
  ValueId,
  ValueType
} from "#compiler/ir/values/types.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/ir/refs.js";
import {
  memoryReadOperation,
  resourceReadNode,
  resourceWriteNode
} from "#test/support/storage-operations.js";

function blockWith(
  nodes: readonly RegionNode[] | ((values: ValueTable) => readonly RegionNode[])
): FunctionGraph {
  const values = new ValueTable();

  for (let value = 0; value < 10; value += 1) {
    values.const(value);
  }

  return {
    body: { nodes: typeof nodes === "function" ? nodes(values) : nodes },
    values
  };
}

function entryBlock(values: ValueTable, nodes: readonly RegionNode[]): FunctionGraph {
  return {
    values,
    body: { nodes }
  };
}

const validationDispatch = testFunctionDefinition(
  "validation.dispatch",
  ["i32"],
  ["i64"]
);

function dispatchReturn(targetEip: number): RegionNode {
  return returnControl.create({
    source: {
      kind: "invocation",
      invocation: Invocation.create({
        target: validationDispatch,
        arguments: [{ value: valueId(targetEip), type: "i32" }]
      })
    }
  });
}

function exitReturn(values: ValueTable): RegionNode {
  return returnControl.create({
    source: { kind: "values", values: [values.const64(0n)] }
  });
}

const dispatchReturn0 = dispatchReturn(0);

function validateFunctionBlock(block: FunctionGraph): void {
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

  validateIrFunction({
    ...block,
    type: functionType(
      parameters.map((parameter) => block.values.valueType(parameter)),
      ["i64"]
    ),
    parameters
  });
}

function testCell(): CellRef<"i32"> {
  return new CellRef("i32");
}

function cellReadNode(
  output: ValueId,
  cell: CellRef
): RegionNode {
  return cellRead.create({ cell }, () => output);
}

const validationResource = resourceRef("test.validation-resource");

function resourceOperand(
  range: ByteRange,
  base: ValueId,
  displacement: number,
  width: IntegerWidth,
  resource: ResourceRef = validationResource
): ResourceByteOperand {
  return {
    effect: { space: "resource", resource, range },
    address: { base, displacement },
    width
  };
}

function allocateOutput(
  values: ValueTable
): (result: OperationResult) => ValueId {
  return (result) => result.type === "i64"
    ? values.addNodeOutput64()
    : values.addNodeOutput(result.bounds);
}

function refinedResourceReadNode(
  values: ValueTable,
  output: ValueId
): RegionNode {
  return resourceRead.create({
    source: resourceOperand(
      { basis: { kind: "resource" } },
      values.const(0),
      0,
      32
    ),
    mode: { kind: "unsigned", bounds: values.widthBounds(output) }
  }, () => output);
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

function blockWithResourceOperation(
  values: ValueTable,
  operation: ResourceOperation
): FunctionGraph {
  return entryBlock(values, [operation, exitReturn(values)]);
}

test("a terminal if with both bodies complete validates", () => {
  doesNotThrow(() =>
    validateFunctionBlock(
      blockWith([
        ifControl.create({
          condition: valueId(0),
          thenBody: { nodes: [dispatchReturn0] },
          elseBody: { nodes: [dispatchReturn(1)] }
        })
      ])
    )
  );
});

test("a returned invocation with the enclosing function result shape validates", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const type = functionType(["i32"], ["i64"]);
  const target = testFunctionDefinition("validation.return-call", ["i32"], ["i64"]);
  const fn: IrFunction = {
    type,
    parameters: [argument],
    values,
    body: {
      nodes: [returnControl.create({
        source: {
          kind: "invocation",
          invocation: Invocation.create({
            target,
            arguments: [{ value: argument, type: "i32" }]
          })
        }
      })]
    }
  };

  doesNotThrow(() => validateIrFunction(fn));
});

test("a returned invocation rejects different function results", () => {
  const values = new ValueTable();
  const target = testFunctionDefinition("validation.return-call-result", [], ["i64"]);
  const fn: IrFunction = {
    type: functionType([], ["i32"]),
    parameters: [],
    values,
    body: {
      nodes: [returnControl.create({
        source: {
          kind: "invocation",
          invocation: Invocation.create({ target, arguments: [] })
        }
      })]
    }
  };

  throws(
    () => validateIrFunction(fn),
    /invocation results do not match the enclosing function/
  );
});

test("a returned invocation validates exact arguments and value types", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const target = testFunctionDefinition("validation.return-call-argument", ["i64"], []);
  const invocation = Invocation.create({
    target,
    arguments: [{ value: argument, type: "i64" }]
  });
  const control = returnControl.create({
    source: { kind: "invocation", invocation }
  });
  const fn: IrFunction = {
    type: functionType(["i32"], []),
    parameters: [argument],
    values,
    body: { nodes: [control] }
  };

  throws(() => validateIrFunction(fn), /invocation input 0 must be i64, got i32/);

  const missingInvocation = {
    ...invocation,
    arguments: [],
    inputs: [],
    operands: []
  } as unknown as Invocation;
  const missingInputs = returnControl.create({
    source: { kind: "invocation", invocation: missingInvocation }
  });

  throws(
    () => validateIrFunction({ ...fn, body: { nodes: [missingInputs] } }),
    /passes 0 arguments to 1 parameters/
  );
});

test("a node after a value return is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(
        blockWith((values) => [
          exitReturn(values),
          resourceWriteNode(values, 0, 0)
        ])
      ),
    /has nodes after its terminal return control/
  );
});

test("a node after an invocation return is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(blockWith((values) => [
        dispatchReturn0,
        resourceWriteNode(values, 0, 0)
      ])),
    /has nodes after its terminal return control/
  );
});

test("a node after a terminal if is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(
        blockWith((values) => [
        ifControl.create({
          condition: valueId(0),
          thenBody: { nodes: [dispatchReturn0] },
          elseBody: { nodes: [exitReturn(values)] }
        }),
          resourceWriteNode(values, 0, 0)
        ])
      ),
    /has nodes after its terminal if control/
  );
});

test("a body that does not complete is rejected", () => {
  throws(
    () => validateFunctionBlock(blockWith((values) => [resourceWriteNode(values, 0, 0)])),
    /root body does not complete/
  );
});

test("a returned invocation argument must be a known value", () => {
  throws(
    () => validateFunctionBlock(blockWith([dispatchReturn(99)])),
    /unknown value id 99/
  );
});

test("operation output bounds must match the operation signature", () => {
  const missingBounds = new ValueTable();
  const missingBoundsAddress = missingBounds.const(0);
  const missingBoundsOutput = missingBounds.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(missingBounds, [
          memoryReadOperation(missingBoundsOutput, missingBoundsAddress, 8),
          exitReturn(missingBounds)
        ])
      ),
    /resource\.read operation output \d+ has the wrong bounds/
  );

  const overlyNarrow = new ValueTable();
  const overlyNarrowAddress = overlyNarrow.const(0);
  const overlyNarrowOutput = overlyNarrow.addNodeOutput(fitsUnsigned(8));

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(overlyNarrow, [
          memoryReadOperation(overlyNarrowOutput, overlyNarrowAddress, 32),
          exitReturn(overlyNarrow)
        ])
      ),
    /resource\.read operation output \d+ has the wrong bounds/
  );
});

test("valid narrow signed resource read and write nodes validate", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const value = values.const(0x1234);
  const range: ByteRange = {
    basis: {
      kind: "dynamic",
      origin: new DynamicByteOriginRef()
    },
    slice: { byteOffset: 4, byteLength: 2 }
  };
  const read = resourceRead.create({
    source: resourceOperand(range, address, 4, 16),
    mode: { kind: "signed" }
  }, () => values.addNodeOutput(signExtended(16)));
  const write = resourceWrite.create({
    destination: resourceOperand(range, address, 4, 16),
    value
  });

  doesNotThrow(() => validateFunctionBlock(entryBlock(values, [
    read,
    write,
    exitReturn(values)
  ])));
});

test("resource operation validation rejects invalid displacements", () => {
  for (const [kind, displacement] of [
    ["read", -1],
    ["write", 1.5]
  ] as const) {
    const values = new ValueTable();
    const address = values.const(0);
    const value = values.const(1);
    const range: ByteRange = { basis: { kind: "resource" } };
    const operation: ResourceOperation = kind === "read"
      ? resourceRead.create({
          source: resourceOperand(range, address, displacement, 8)
        }, allocateOutput(values))
      : resourceWrite.create({
          destination: resourceOperand(range, address, displacement, 8),
          value
        });

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
      /address displacement must be an unsigned 32-bit integer/
    );
  }
});

test("resource operation validation rejects invalid width and signedness", () => {
  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        32
      )
    }, allocateOutput(values));
    const operation = { ...read, signed: true } as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
      /signedness is valid only for a narrow read/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        64 as IntegerWidth
      )
    }, () => values.addNodeOutput());
    const operation = {
      ...read,
      results: [{ type: "i32" }]
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
      /width must be 8, 16, or 32/
    );
  }
});

test("resource operation validation rejects malformed identities and range bases", () => {
  const cases: readonly [ByteRange, ResourceRef, RegExp][] = [
    [
      { basis: undefined } as unknown as ByteRange,
      validationResource,
      /range is missing its basis/
    ],
    [
      { basis: { kind: "unknown" } } as unknown as ByteRange,
      validationResource,
      /range has an unknown basis/
    ],
    [
      {
        basis: {
          kind: "dynamic",
          origin: {} as DynamicByteOriginRef
        }
      },
      validationResource,
      /dynamic basis origin must be a DynamicByteOriginRef/
    ],
    [
      { basis: { kind: "resource" } },
      { kind: "resource", id: "" } as ResourceRef,
      /effect has an invalid resource identity/
    ]
  ];

  for (const [range, resource, expected] of cases) {
    const values = new ValueTable();
    const address = values.const(0);
    const operation = resourceRead.create({
      source: resourceOperand(range, address, 0, 8, resource)
    }, allocateOutput(values));

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
      expected
    );
  }
});

test("resource operation validation rejects invalid byte slices", () => {
  const cases: readonly [ByteRange, RegExp][] = [
    [{
      basis: { kind: "resource" },
      slice: { byteOffset: -1, byteLength: 1 }
    }, /slice byte offset must be a non-negative integer/],
    [{
      basis: { kind: "resource" },
      slice: { byteOffset: 1.5, byteLength: 1 }
    }, /slice byte offset must be a non-negative integer/],
    [{
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 0 }
    }, /range byte length must be a positive integer/],
    [{
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 1.5 }
    }, /range byte length must be a positive integer/],
    [{
      basis: {
        kind: "dynamic",
        origin: new DynamicByteOriginRef()
      },
      slice: { byteOffset: 0xffff_ffff, byteLength: 2 }
    }, /range end must not exceed 2\^32 bytes/]
  ];

  for (const [range, expected] of cases) {
    const values = new ValueTable();
    const address = values.const(0);
    const operation = resourceRead.create({
      source: resourceOperand(range, address, 0, 8)
    }, allocateOutput(values));

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
      expected
    );
  }
});

test("resource operation validation rejects a slice smaller than its transfer", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const operation = resourceRead.create({
    source: resourceOperand(
      {
        basis: { kind: "resource" },
        slice: { byteOffset: 0, byteLength: 1 }
      },
      address,
      0,
      32
    )
  }, allocateOutput(values));

  throws(
    () => validateFunctionBlock(blockWithResourceOperation(values, operation)),
    /range byte length 1 must contain its 32-bit transfer/
  );
});

test("resource operation validation accepts a containing conservative slice", () => {
  const values = new ValueTable();
  const address = values.const(0);
  const operation = resourceRead.create({
    source: resourceOperand(
      {
        basis: { kind: "resource" },
        slice: { byteOffset: 8, byteLength: 32 }
      },
      address,
      8,
      32
    )
  }, allocateOutput(values));

  doesNotThrow(
    () => validateFunctionBlock(blockWithResourceOperation(values, operation))
  );
});

test("resource operation validation rejects incoherent retained effects", () => {
  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      )
    }, allocateOutput(values));
    const effects = { reads: [], writes: [read.effect] };
    const forged = {
      ...read,
      directEffects: effects
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /effects must read its exact resource effect and write nothing/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const value = values.const(1);
    const write = resourceWrite.create({
      destination: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      ),
      value
    });
    const effects = { reads: [write.effect], writes: [] };
    const forged = {
      ...write,
      directEffects: effects
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /effects must write its exact resource effect and read nothing/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      )
    }, allocateOutput(values));
    const structurallyEqualEffect = {
      ...read.effect,
      range: { ...read.effect.range }
    };
    const effects = { reads: [structurallyEqualEffect], writes: [] };
    const forged = {
      ...read,
      directEffects: effects
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /effects must read its exact resource effect and write nothing/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      )
    }, allocateOutput(values));
    const forged = {
      ...read,
      referencedResources: [resourceRef("test.wrong-resource-binding")]
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /must reference its exact resource binding/
    );
  }
});

test("resource operation validation rejects incoherent retained inputs", () => {
  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      )
    }, allocateOutput(values));
    const forged = {
      ...read,
      inputs: [],
      operands: []
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /must have exactly one i32 address input/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const value = values.const(1);
    const write = resourceWrite.create({
      destination: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      ),
      value
    });
    const inputs = [
      { value: address, type: "i32" as const },
      { value, type: "i64" as const }
    ];
    const forged = {
      ...write,
      inputs,
      operands: inputs.map((input) => input.value)
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /must have exactly one i32 address and one i32 value input/
    );
  }
});

test("resource operation validation rejects incoherent retained results", () => {
  {
    const values = new ValueTable();
    const address = values.const(0);
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      )
    }, allocateOutput(values));
    const forged = {
      ...read,
      results: [],
      outputs: []
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /must have an i32 result/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const output = values.addNodeOutput(fitsUnsigned(7));
    const read = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      ),
      mode: { kind: "signed" }
    }, () => output);
    const forged = {
      ...read,
      results: [{ type: "i32", bounds: fitsUnsigned(7) }]
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /signed result bounds must match its mechanical load bounds/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const value = values.const(1);
    const write = resourceWrite.create({
      destination: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        8
      ),
      value
    });
    const output = values.addNodeOutput();
    const forged = {
      ...write,
      results: [{ type: "i32" }],
      outputs: [output]
    } as unknown as ResourceOperation;

    throws(
      () => validateFunctionBlock(blockWithResourceOperation(values, forged)),
      /must not have results/
    );
  }
});

test("unsigned resource read bounds may refine within mechanical bounds", () => {
  const validValues = new ValueTable();
  const validAddress = validValues.const(0);
  const valid = resourceRead.create({
    source: resourceOperand(
      { basis: { kind: "resource" } },
      validAddress,
      0,
      8
    ),
    mode: { kind: "unsigned", bounds: fitsUnsigned(1) }
  }, allocateOutput(validValues));

  doesNotThrow(
    () => validateFunctionBlock(blockWithResourceOperation(validValues, valid))
  );

  const wideValues = new ValueTable();
  const wideAddress = wideValues.const(0);
  const tooWide = resourceRead.create({
    source: resourceOperand(
      { basis: { kind: "resource" } },
      wideAddress,
      0,
      8
    ),
    mode: { kind: "unsigned", bounds: fitsUnsigned(16) }
  }, allocateOutput(wideValues));

  throws(
    () => validateFunctionBlock(blockWithResourceOperation(wideValues, tooWide)),
    /result bounds exceed its mechanical load bounds/
  );

  const malformedValues = new ValueTable();
  const malformedAddress = malformedValues.const(0);
  const malformed = resourceRead.create({
    source: resourceOperand(
      { basis: { kind: "resource" } },
      malformedAddress,
      0,
      8
    ),
    mode: {
      kind: "unsigned",
      bounds: { unsignedBits: -1, signedBits: 0 }
    }
  }, allocateOutput(malformedValues));

  throws(
    () => validateFunctionBlock(blockWithResourceOperation(malformedValues, malformed)),
    /result 0 bounds are malformed/
  );
});

test("nested invocation and value returns are generic control", () => {
  doesNotThrow(() =>
    validateFunctionBlock(
      blockWith((values) => [ifControl.create({
        condition: valueId(0),
        thenBody: { nodes: [dispatchReturn0] },
        elseBody: { nodes: [exitReturn(values)] }
      })])
    )
  );
});

function switchBlock(
  buildOverrides:
    | Partial<SwitchControlArgs>
    | ((values: ValueTable) => Partial<SwitchControlArgs>)
): FunctionGraph {
  const values = new ValueTable();

  for (let value = 0; value < 5; value += 1) {
    values.const(value);
  }

  const overrides = typeof buildOverrides === "function"
    ? buildOverrides(values)
    : buildOverrides;
  const args: SwitchControlArgs = {
    selector: valueId(0),
    output: values.addNodeOutput(),
    cases: [
      { matches: [0], body: { nodes: [], result: valueId(2) } },
      { matches: [2], body: { nodes: [], result: valueId(3) } }
    ],
    defaultBody: { nodes: [], result: valueId(4) },
    ...overrides
  };
  const node = switchControl.create(args);

  return entryBlock(values, [node, exitReturn(values)]);
}

test("a switch whose bodies all carry results validates", () => {
  doesNotThrow(() => validateFunctionBlock(switchBlock({})));
});

test("a control-only switch accepts fallthrough bodies without results", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const selection = switchControl.create({
    selector,
    cases: [{
      matches: [0, 2, 4],
      body: { nodes: [] }
    }],
    defaultBody: { nodes: [] }
  });

  doesNotThrow(() => validateFunctionBlock({
    values,
    body: { nodes: [selection, exitReturn(values)] }
  }));
});

test("a control-only switch accepts bodies that all escape", () => {
  const values = new ValueTable();
  const selection = switchControl.create({
    selector: values.const(0),
    cases: [{ matches: [0], body: { nodes: [exitReturn(values)] } }],
    defaultBody: { nodes: [exitReturn(values)] }
  });

  doesNotThrow(() => validateFunctionBlock({ values, body: { nodes: [selection] } }));
});

test("a value-producing switch still requires every body result", () => {
  throws(
    () =>
      validateFunctionBlock(switchBlock((values) => ({
        cases: [{ matches: [0], body: { nodes: [exitReturn(values)] } }]
      }))),
    /case\[0\] must carry a result/
  );
});

test("a control-only switch rejects a body result", () => {
  const values = new ValueTable();
  const result = values.const(1);
  const selection = switchControl.create({
    selector: values.const(0),
    cases: [{ matches: [0], body: { nodes: [], result } }],
    defaultBody: { nodes: [] }
  });

  throws(
    () => validateFunctionBlock({ values, body: { nodes: [selection, exitReturn(values)] } }),
    /case\[0\] carries a result without an owner output/
  );
});

test("a result on the root body is rejected", () => {
  const values = new ValueTable();
  const result = values.const(1);

  throws(
    () => validateFunctionBlock({ values, body: { nodes: [exitReturn(values)], result } }),
    /body carries a result without an owner output/
  );
});

test("a result under an output-less owner is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(
        blockWith((values) => [
          ifControl.create({
            condition: valueId(0),
            thenBody: { nodes: [exitReturn(values)], result: valueId(1) }
          }),
          exitReturn(values)
        ])
      ),
    /thenBody carries a result without an owner output/
  );
});

test("a result on a completing body is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(switchBlock((values) => ({
        cases: [{ matches: [0], body: { nodes: [exitReturn(values)], result: valueId(2) } }]
      }))),
    /case\[0\] carries a result but completes/
  );
});

test("an output-owner body that neither escapes nor carries a result is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(switchBlock({ defaultBody: { nodes: [] } })),
    /default must carry a result/
  );
});

test("a duplicate switch case match is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(
        switchBlock({
          cases: [
            { matches: [1], body: { nodes: [], result: valueId(2) } },
            { matches: [1], body: { nodes: [], result: valueId(3) } }
          ]
        })
      ),
    /has a duplicate case match 1/
  );
});

test("an overlapping switch case match is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(
        switchBlock({
          cases: [
            {
              matches: [1, 2, 3],
              body: { nodes: [], result: valueId(2) }
            },
            { matches: [3], body: { nodes: [], result: valueId(3) } }
          ]
        })
      ),
    /has a duplicate case match 3/
  );
});

test("a negative switch case match is rejected", () => {
  throws(
    () =>
      validateFunctionBlock(switchBlock({ cases: [{ matches: [-1], body: { nodes: [], result: valueId(2) } }] })),
    /case match -1 is not an integer in \[0, 255\]/
  );
});

test("a switch case match beyond the dense-table bound is rejected", () => {
  doesNotThrow(() =>
    validateFunctionBlock(switchBlock({ cases: [{ matches: [maxSwitchMatch], body: { nodes: [], result: valueId(2) } }] }))
  );
  throws(
    () =>
      validateFunctionBlock(switchBlock({ cases: [{ matches: [maxSwitchMatch + 1], body: { nodes: [], result: valueId(2) } }] })),
    /case match 256 is not an integer in \[0, 255\]/
  );
});

test("a switch without a default body is rejected", () => {
  const block = switchBlock({});
  const node = block.body.nodes[0];
  const terminal = block.body.nodes[1];

  ok(node?.kind === "switch");
  ok(terminal !== undefined);
  const nestedBodies = node.nestedBodies.slice(0, -1);
  const missingDefaultNode = {
    ...node,
    defaultBody: undefined,
    nestedBodies
  } as unknown as SwitchControl;
  const missingDefault: FunctionGraph = {
    ...block,
    body: { nodes: [missingDefaultNode, terminal] }
  };

  throws(
    () => validateFunctionBlock(missingDefault),
    /nested bodies do not match its cases and default/
  );
});

test("a loop with a carried cell and an aligned continue validates", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const update = values.binary("sub", loopInput, values.const(1));

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        loopControl.create({
          carried: [{ seed, loopInput }],
          body: {
            nodes: [
              ifControl.create({
                condition: update,
                thenBody: {
                  nodes: [loopContinueControl.create({ updates: [update] })]
                }
              }),
              resourceWriteNode(values, 0, update)
            ]
          }
        }),
        dispatchReturn0
      ])
    )
  );
});

test("a cell read before its seed is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(7);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(seed);

  builder.read(cell);
  builder.push(exitReturn(values));
  const body = builder.build();
  const seedNode = body.nodes[0];
  const readNode = body.nodes[1];
  const returnNode = body.nodes[2];

  ok(seedNode !== undefined);
  ok(readNode !== undefined);
  ok(returnNode !== undefined);

  (body.nodes as RegionNode[]).splice(0, 3, readNode, seedNode, returnNode);

  throws(
    () => validateFunctionBlock({ values, body }),
    /before its seed/
  );
});

test("a cell cannot be seeded more than once", () => {
  const values = new ValueTable();
  const seed = values.const(7);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(seed);

  builder.operation(cellWrite, {
    cell,
    value: seed,
    initialization: "seed"
  });
  builder.push(exitReturn(values));

  throws(
    () => validateFunctionBlock({ values, body: builder.build() }),
    /seeds the same cell more than once/
  );
});

test("a cell access without any seed is rejected", () => {
  const values = new ValueTable();
  const target = values.const(7);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(target);

  builder.read(cell);
  builder.push(exitReturn(values));
  const body = builder.build();

  (body.nodes as RegionNode[]).splice(0, 1);

  throws(
    () => validateFunctionBlock({ values, body }),
    /cell with no seed/
  );
});

test("a cell from another root is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(7);
  const source = new RegionBuilder(values);
  const foreign = source.cell(seed);

  source.read(foreign);
  const foreignRead = source.build().nodes[1];

  ok(foreignRead !== undefined);
  const target = new RegionBuilder(values);

  target.cell(seed);
  target.push(foreignRead);
  target.push(exitReturn(values));

  throws(
    () => validateFunctionBlock({ values, body: target.build() }),
    /cell with no seed in this root/
  );
});

test("a cell declared in one sibling body cannot be used in another", () => {
  const values = new ValueTable();
  const condition = values.parameter(0, "i32");
  const seed = values.const(7);
  const builder = new RegionBuilder(values);
  let cell!: CellRef;

  builder.if(
    condition,
    (then) => {
      cell = then.cell(seed);
    },
    { elseBuild: () => {} }
  );
  builder.push(exitReturn(values));
  const body = builder.build();
  const branch = body.nodes[0];

  if (branch?.kind !== "if" || branch.elseBody === undefined) {
    throw new Error("test branch did not build both arms");
  }
  (branch.elseBody.nodes as RegionNode[]).push(
    cellReadNode(values.addNodeOutput(), cell)
  );

  throws(() => validateFunctionBlock({ values, body }), /outside its declaring body or descendants/);
});

test("a child cell cannot escape to its parent body", () => {
  const values = new ValueTable();
  const condition = values.parameter(0, "i32");
  const seed = values.const(7);
  const builder = new RegionBuilder(values);
  let cell!: CellRef;

  builder.if(condition, (then) => {
    cell = then.cell(seed);
  });
  builder.push(cellReadNode(values.addNodeOutput(), cell));
  builder.push(exitReturn(values));

  throws(
    () => validateFunctionBlock({ values, body: builder.build() }),
    /outside its declaring body or descendants/
  );
});

test("a cell declared outside a loop can be written in a nested loop arm", () => {
  const values = new ValueTable();
  const condition = values.parameter(0, "i32");
  const seed = values.const(7);
  const update = values.const(6);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(seed);

  builder.loop([], (loop) => {
    loop.if(condition, (arm) => arm.write(cell, update));
  });
  builder.push(exitReturn(values));

  doesNotThrow(() => validateFunctionBlock({ values, body: builder.build() }));
});

test("a hand-assembled body declares cell scope by its seed node alone", () => {
  // The seed write is the cell declaration for hand-assembled and
  // builder-built function bodies alike.
  const values = new ValueTable();
  const seed = values.const(7);
  const cell = testCell();

  doesNotThrow(
    () => validateFunctionBlock(entryBlock(values, [
      cellWrite.create(
        { cell, value: seed, initialization: "seed" }
      ),
      cellReadNode(values.addNodeOutput(), cell),
      dispatchReturn(seed)
    ]))
  );
});

test("a hand-assembled nested body may use an ancestor cell", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const seed = values.const(7);
  const cell = builder.cell(seed);
  const rawChild: Region = {
    nodes: [cellReadNode(values.addNodeOutput(), cell)]
  };

  builder.push(ifControl.create({
    condition: values.parameter(0, "i32"),
    thenBody: rawChild
  }));
  builder.push(exitReturn(values));

  doesNotThrow(() => validateFunctionBlock({ values, body: builder.build() }));
});

test("a loopContinue outside any loop body is rejected", () => {
  throws(
    () => validateFunctionBlock(blockWith([
      loopContinueControl.create({ updates: [] })
    ])),
    /loopContinue outside any loop body/
  );
});

test("loopContinue updates misaligned with the carried list are rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: {
              nodes: [loopContinueControl.create({ updates: [] })]
            }
          }),
          dispatchReturn0
        ])
      ),
    /updates do not align/
  );
});

test("a carried loop input validates", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();

  doesNotThrow(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: {
              nodes: [loopContinueControl.create({ updates: [loopInput] })]
            }
          }),
          dispatchReturn0
        ])
      )
  );
});

test("a carried cell whose input is not a loopInput value is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput: seed }],
            body: {
              nodes: [loopContinueControl.create({ updates: [seed] })]
            }
          }),
          dispatchReturn0
        ])
      ),
    /is not a loopInput value/
  );
});

test("used and unused node outputs without producers are rejected", () => {
  const unusedValues = new ValueTable();

  unusedValues.addNodeOutput();
  throws(
    () => validateFunctionBlock(entryBlock(unusedValues, [exitReturn(unusedValues)])),
    /node output \d+ has no producer/
  );

  const usedValues = new ValueTable();
  const used = usedValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(usedValues, [
          resourceWriteNode(usedValues, 0, used),
          exitReturn(usedValues)
        ])
      ),
    /node output \d+ has no producer/
  );
});

test("producer outputs must name nodeOutput values", () => {
  const constValues = new ValueTable();
  constValues.const(0);
  const constant = constValues.const(1);

  throws(
    () => validateFunctionBlock(entryBlock(constValues, [
      refinedResourceReadNode(constValues, constant),
      exitReturn(constValues)
    ])),
    /producer output \d+ is not a nodeOutput value/
  );

  const compoundValues = new ValueTable();
  compoundValues.const(0);
  const compound = compoundValues.binary("add", compoundValues.parameter(0, "i32"), compoundValues.const(1));

  throws(
    () => validateFunctionBlock(entryBlock(compoundValues, [
      refinedResourceReadNode(compoundValues, compound),
      exitReturn(compoundValues)
    ])),
    /producer output \d+ is not a nodeOutput value/
  );

  const loopValues = new ValueTable();
  loopValues.const(0);
  const loopInput = loopValues.addLoopInput();

  throws(
    () => validateFunctionBlock(entryBlock(loopValues, [
      refinedResourceReadNode(loopValues, loopInput),
      exitReturn(loopValues)
    ])),
    /producer output \d+ is not a nodeOutput value/
  );
});

test("duplicate operation producers and operation-vs-switch producers are rejected", () => {
  const opValues = new ValueTable();
  opValues.const(0);
  const opOutput = opValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(opValues, [
          resourceReadNode(opValues, opOutput, 0),
          resourceReadNode(opValues, opOutput, 0),
          exitReturn(opValues)
        ])
      ),
    /node output \d+ has more than one producer/
  );

  const mixedValues = new ValueTable();
  const selector = mixedValues.const(0);
  const result = mixedValues.const(1);
  const mixedOutput = mixedValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(mixedValues, [
          resourceReadNode(mixedValues, mixedOutput, 0),
          switchControl.create({
            selector,
            output: mixedOutput,
            cases: [{ matches: [0], body: { nodes: [], result } }],
            defaultBody: { nodes: [], result }
          }),
          exitReturn(mixedValues)
        ])
      ),
    /node output \d+ has more than one producer/
  );
});

test("a same-body compound use before its producer is rejected", () => {
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
    /node output \d+.*does not dominate/
  );

  const values = new ValueTable();
  values.const(0);
  const output = values.addNodeOutput();
  const compound = values.binary("add", output, values.parameter(0, "i32"));

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          resourceWriteNode(values, 0, compound),
          resourceReadNode(values, output, 0),
          exitReturn(values)
        ])
      ),
    /node output \d+.*does not dominate/
  );
});

test("a node output cannot be used from a sibling body", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  values.const(0);
  const output = values.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          ifControl.create({
            condition,
            thenBody: { nodes: [resourceReadNode(values, output, 0)] },
            elseBody: { nodes: [resourceWriteNode(values, 0, output)] }
          }),
          exitReturn(values)
        ])
      ),
    /node output \d+.*does not dominate/
  );
});

test("one Region object cannot be reused under multiple controls", () => {
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
    /reuses a Region object that already has an owner/
  );
});

test("a loop input is scoped to its owning loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          resourceWriteNode(values, 0, loopInput),
          exitReturn(values)
        ])
      ),
    /loop input \d+ is used outside its owning loop body/
  );
});

test("a loop input cannot be reused by a sibling loop", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          exitReturn(values)
        ])
      ),
    /reuses loop input \d+ across carried cells or loops/
  );
});

test("a loop input cannot be consumed inside a sibling loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          loopControl.create({
            carried: [],
            body: { nodes: [resourceWriteNode(values, 0, loopInput)] }
          }),
          exitReturn(values)
        ])
      ),
    /loop input \d+ is used outside its owning loop body/
  );
});

test("a loop-body node output cannot escape directly after the loop", () => {
  const values = new ValueTable();
  values.const(0);
  const output = values.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [],
            body: { nodes: [resourceReadNode(values, output, 0)] }
          }),
          resourceWriteNode(values, 0, output),
          exitReturn(values)
        ])
      ),
    /node output \d+.*does not dominate/
  );
});

test("a switch output cannot be its own selector or arm result", () => {
  const selectorValues = new ValueTable();
  const selectorResult = selectorValues.const(1);
  const selectorOutput = selectorValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(selectorValues, [
          switchControl.create({
            selector: selectorOutput,
            output: selectorOutput,
            cases: [{ matches: [0], body: { nodes: [], result: selectorResult } }],
            defaultBody: { nodes: [], result: selectorResult }
          }),
          exitReturn(selectorValues)
        ])
      ),
    /switch operand \d+ created after its output/
  );

  const resultValues = new ValueTable();
  const resultSelector = resultValues.const(0);
  const resultOutput = resultValues.addNodeOutput();

  throws(
    () =>
      validateFunctionBlock(
        entryBlock(resultValues, [
          switchControl.create({
            selector: resultSelector,
            output: resultOutput,
            cases: [{ matches: [0], body: { nodes: [], result: resultOutput } }],
            defaultBody: { nodes: [], result: resultSelector }
          }),
          exitReturn(resultValues)
        ])
      ),
    /switch result \d+ created after its output/
  );
});

test("a valid switch output can be used after the switch", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const result = values.const(1);
  const output = values.addNodeOutput();

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        switchControl.create({
          selector,
          output,
          cases: [{ matches: [0], body: { nodes: [], result } }],
          defaultBody: { nodes: [], result }
        }),
        resourceWriteNode(values, 0, output),
        exitReturn(values)
      ])
    )
  );
});

test("an ancestor producer can feed nested if, switch-result, and loop-body uses", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const fallback = values.const(0);
  const output = values.addNodeOutput();
  const switchOutput = values.addNodeOutput();

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        resourceReadNode(values, output, 0),
        ifControl.create({
          condition,
          thenBody: { nodes: [resourceWriteNode(values, 0, output)] }
        }),
        switchControl.create({
          selector: condition,
          output: switchOutput,
          cases: [{ matches: [0], body: { nodes: [], result: output } }],
          defaultBody: { nodes: [], result: fallback }
        }),
        loopControl.create({
          carried: [],
          body: { nodes: [resourceWriteNode(values, 0, output)] }
        }),
        exitReturn(values)
      ])
    )
  );
});

test("a body-local producer can feed its body result", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const armOutput = values.addNodeOutput();
  const formula = values.binary("add", armOutput, values.const(1));
  const fallback = values.const(7);
  const switchOutput = values.addNodeOutput();

  doesNotThrow(() =>
    validateFunctionBlock(
      entryBlock(values, [
        switchControl.create({
          selector,
          output: switchOutput,
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

test("producer operands must have lower value ids than their output", () => {
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
    /producer operand \d+ created after its output/
  );
});
