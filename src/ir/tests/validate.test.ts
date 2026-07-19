import { doesNotThrow, ok, throws } from "node:assert";
import { test } from "node:test";

import {
  finishControl,
  ifControl,
  loopContinueControl,
  loopControl,
  maxSwitchMatch,
  returnCallControl,
  switchControl,
  type ReturnCallControl,
  type SwitchControl,
  type SwitchControlArgs
} from "#compiler/ir/controls/index.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import type { BodyNode, Body, IrBlock } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import type { IrFunction } from "#ir/function.js";
import { validateIrBlock, validateIrFunction } from "#ir/validate.js";
import { CellRef } from "#compiler/refs/cell.js";
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
import { functionType } from "#compiler/program/function-type.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionRef } from "#compiler/program/refs.js";
import {
  memoryReadOperation,
  resourceReadNode,
  resourceWriteNode
} from "./storage-op-helpers.js";

function blockWith(
  nodes: readonly BodyNode[] | ((values: ValueTable) => readonly BodyNode[])
): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 10; value += 1) {
    values.const(value);
  }

  return {
    body: { nodes: typeof nodes === "function" ? nodes(values) : nodes },
    values
  };
}

function entryBlock(values: ValueTable, nodes: readonly BodyNode[]): IrBlock {
  return {
    values,
    body: { nodes }
  };
}

function finishDispatch(targetEip: number): BodyNode {
  return finishControl.create({
    finish: { kind: "dispatch", targetEip: valueId(targetEip) }
  });
}

function finishExit(values: ValueTable): BodyNode {
  return finishControl.create({
    finish: { kind: "exit", result: values.const64(0n) }
  });
}

const finishDispatch0 = finishDispatch(0);

function testCell(): CellRef<"i32"> {
  return new CellRef("i32");
}

function cellReadNode(
  output: ValueId,
  cell: CellRef
): BodyNode {
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
): BodyNode {
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
): IrBlock {
  return entryBlock(values, [operation, finishExit(values)]);
}

test("a body ending with a finish exit validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith((values) => [finishExit(values)])));
});

test("a body ending with a finish dispatch validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith([finishDispatch0])));
});

test("an implicit fragment body end validates only when allowed", () => {
  const block = blockWith((values) => [resourceWriteNode(values, 0, 0)]);

  throws(() => validateIrBlock(block), /root body does not complete/);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("a terminal if with both bodies complete validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        ifControl.create({
          condition: valueId(0),
          thenBody: { nodes: [finishDispatch0] },
          elseBody: { nodes: [finishDispatch(1)] }
        })
      ])
    )
  );
});

test("a terminal returnCall with the enclosing function result shape validates", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const type = functionType(["i32"], ["i64"]);
  const target = testFunctionDefinition("validation.return-call", ["i32"], ["i64"]);
  const fn: IrFunction = {
    type,
    parameters: [argument],
    values,
    body: {
      nodes: [returnCallControl.create({
        target,
        arguments: [{ value: argument, type: "i32" }]
      })]
    }
  };

  doesNotThrow(() => validateIrFunction(fn));
});

test("a returnCall rejects a target with different function results", () => {
  const values = new ValueTable();
  const target = testFunctionDefinition("validation.return-call-result", [], ["i64"]);
  const fn: IrFunction = {
    type: functionType([], ["i32"]),
    parameters: [],
    values,
    body: {
      nodes: [returnCallControl.create({ target, arguments: [] })]
    }
  };

  throws(
    () => validateIrFunction(fn),
    /target results do not match the enclosing function/
  );
});

test("a returnCall validates exact retained arguments and their value types", () => {
  const values = new ValueTable();
  const argument = values.parameter(0, "i32");
  const target = testFunctionDefinition("validation.return-call-argument", ["i64"], []);
  const control = returnCallControl.create({
    target,
    arguments: [{ value: argument, type: "i64" }]
  });
  const fn: IrFunction = {
    type: functionType(["i32"], []),
    parameters: [argument],
    values,
    body: { nodes: [control] }
  };

  throws(() => validateIrFunction(fn), /argument 0 must be i64, got i32/);

  const missingInputs = {
    ...control,
    inputs: [],
    operands: []
  } as unknown as ReturnCallControl;

  throws(
    () => validateIrFunction({ ...fn, body: { nodes: [missingInputs] } }),
    /passes 0 arguments to 1 parameters/
  );
});

test("a returnCall is rejected in a block body", () => {
  const values = new ValueTable();
  const target = testFunctionDefinition("validation.block-return-call", [], []);

  throws(
    () => validateIrBlock(entryBlock(values, [
      returnCallControl.create({ target, arguments: [] })
    ])),
    /returns from a block body/
  );
});

test("a node after the finish exit terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
          finishExit(values),
          resourceWriteNode(values, 0, 0)
        ])
      ),
    /has nodes after its terminal finish control/
  );
});

test("a node after a finish dispatch terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(blockWith((values) => [
        finishDispatch0,
        resourceWriteNode(values, 0, 0)
      ])),
    /has nodes after its terminal finish control/
  );
});

test("a node after a terminal if is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
        ifControl.create({
          condition: valueId(0),
          thenBody: { nodes: [finishDispatch0] },
          elseBody: { nodes: [finishExit(values)] }
        }),
          resourceWriteNode(values, 0, 0)
        ])
      ),
    /has nodes after its terminal if control/
  );
});

test("a body that does not complete is rejected", () => {
  throws(
    () => validateIrBlock(blockWith((values) => [resourceWriteNode(values, 0, 0)])),
    /root body does not complete/
  );
});

test("dispatch target must be a known value", () => {
  throws(
    () => validateIrBlock(blockWith([finishDispatch(99)])),
    /unknown value id 99/
  );
});

test("operation output bounds must match the operation signature", () => {
  const missingBounds = new ValueTable();
  const missingBoundsAddress = missingBounds.const(0);
  const missingBoundsOutput = missingBounds.addNodeOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(missingBounds, [
          memoryReadOperation(missingBoundsOutput, missingBoundsAddress, 8),
          finishExit(missingBounds)
        ])
      ),
    /resource\.read operation output \d+ has the wrong bounds/
  );

  const overlyNarrow = new ValueTable();
  const overlyNarrowAddress = overlyNarrow.const(0);
  const overlyNarrowOutput = overlyNarrow.addNodeOutput(fitsUnsigned(8));

  throws(
    () =>
      validateIrBlock(
        entryBlock(overlyNarrow, [
          memoryReadOperation(overlyNarrowOutput, overlyNarrowAddress, 32),
          finishExit(overlyNarrow)
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

  doesNotThrow(() => validateIrBlock(entryBlock(values, [
    read,
    write,
    finishExit(values)
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
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
    () => validateIrBlock(blockWithResourceOperation(values, operation)),
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
    () => validateIrBlock(blockWithResourceOperation(values, operation))
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
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
    () => validateIrBlock(blockWithResourceOperation(validValues, valid))
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
    () => validateIrBlock(blockWithResourceOperation(wideValues, tooWide)),
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
    () => validateIrBlock(blockWithResourceOperation(malformedValues, malformed)),
    /result 0 bounds are malformed/
  );
});

test("a nested dispatch is generic control", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith((values) => [ifControl.create({
        condition: valueId(0),
        thenBody: { nodes: [finishDispatch0] },
        elseBody: { nodes: [finishExit(values)] }
      })])
    )
  );
});

function switchBlock(
  buildOverrides:
    | Partial<SwitchControlArgs>
    | ((values: ValueTable) => Partial<SwitchControlArgs>)
): IrBlock {
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
      { match: 0, body: { nodes: [], result: valueId(2) } },
      { match: 2, body: { nodes: [], result: valueId(3) } }
    ],
    defaultBody: { nodes: [], result: valueId(4) },
    ...overrides
  };
  const node = switchControl.create(args);

  return entryBlock(values, [node, finishExit(values)]);
}

test("a switch whose bodies all carry results validates", () => {
  doesNotThrow(() => validateIrBlock(switchBlock({})));
});

test("an escaping switch body is rejected until a producer arrives", () => {
  throws(
    () =>
      validateIrBlock(switchBlock((values) => ({
        cases: [{ match: 0, body: { nodes: [finishExit(values)] } }]
      }))),
    /case\[0\] must carry a result/
  );
});

test("a result on the root body is rejected", () => {
  const values = new ValueTable();
  const result = values.const(1);

  throws(
    () => validateIrBlock({ values, body: { nodes: [finishExit(values)], result } }),
    /body carries a result without an owner output/
  );
});

test("a result under an output-less owner is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
          ifControl.create({
            condition: valueId(0),
            thenBody: { nodes: [finishExit(values)], result: valueId(1) }
          }),
          finishExit(values)
        ])
      ),
    /thenBody carries a result without an owner output/
  );
});

test("a result on a completing body is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock((values) => ({
        cases: [{ match: 0, body: { nodes: [finishExit(values)], result: valueId(2) } }]
      }))),
    /case\[0\] carries a result but completes/
  );
});

test("an output-owner body that neither escapes nor carries a result is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ defaultBody: { nodes: [] } })),
    /default must carry a result/
  );
});

test("a duplicate switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        switchBlock({
          cases: [
            { match: 1, body: { nodes: [], result: valueId(2) } },
            { match: 1, body: { nodes: [], result: valueId(3) } }
          ]
        })
      ),
    /has a duplicate case match 1/
  );
});

test("a negative switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: -1, body: { nodes: [], result: valueId(2) } }] })),
    /case match -1 is not an integer in \[0, 255\]/
  );
});

test("a switch case match beyond the dense-table bound is rejected", () => {
  doesNotThrow(() =>
    validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch, body: { nodes: [], result: valueId(2) } }] }))
  );
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch + 1, body: { nodes: [], result: valueId(2) } }] })),
    /case match 256 is not an integer in \[0, 255\]/
  );
});

test("a switch without a default body is rejected", () => {
  const block = switchBlock({});
  const node = block.body.nodes[0];
  const finish = block.body.nodes[1];

  ok(node?.kind === "switch");
  ok(finish !== undefined);
  const nestedBodies = node.nestedBodies.slice(0, -1);
  const missingDefaultNode = {
    ...node,
    defaultBody: undefined,
    nestedBodies
  } as unknown as SwitchControl;
  const missingDefault: IrBlock = {
    ...block,
    body: { nodes: [missingDefaultNode, finish] }
  };

  throws(
    () => validateIrBlock(missingDefault),
    /nested bodies do not match its cases and default/
  );
});

test("a loop with a carried cell and an aligned continue validates", () => {
  const values = new ValueTable();
  const seed = values.const(3);
  const loopInput = values.addLoopInput();
  const update = values.binary("sub", loopInput, values.const(1));

  doesNotThrow(() =>
    validateIrBlock(
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
        finishDispatch0
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
  builder.finish({ kind: "dispatch", targetEip: seed });
  const body = builder.build();
  const seedNode = body.nodes[0];
  const readNode = body.nodes[1];
  const finishNode = body.nodes[2];

  ok(seedNode !== undefined);
  ok(readNode !== undefined);
  ok(finishNode !== undefined);

  (body.nodes as BodyNode[]).splice(0, 3, readNode, seedNode, finishNode);

  throws(
    () => validateIrBlock({ values, body }),
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
  builder.finish({ kind: "dispatch", targetEip: seed });

  throws(
    () => validateIrBlock({ values, body: builder.build() }),
    /seeds the same cell more than once/
  );
});

test("a cell access without any seed is rejected", () => {
  const values = new ValueTable();
  const target = values.const(7);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(target);

  builder.read(cell);
  builder.finish({ kind: "dispatch", targetEip: target });
  const body = builder.build();

  (body.nodes as BodyNode[]).splice(0, 1);

  throws(
    () => validateIrBlock({ values, body }),
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
  target.finish({ kind: "dispatch", targetEip: seed });

  throws(
    () => validateIrBlock({ values, body: target.build() }),
    /cell with no seed in this root/
  );
});

test("a cell declared in one sibling body cannot be used in another", () => {
  const values = new ValueTable();
  const condition = values.external(0);
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
  builder.finish({ kind: "dispatch", targetEip: seed });
  const body = builder.build();
  const branch = body.nodes[0];

  if (branch?.kind !== "if" || branch.elseBody === undefined) {
    throw new Error("test branch did not build both arms");
  }
  (branch.elseBody.nodes as BodyNode[]).push(
    cellReadNode(values.addNodeOutput(), cell)
  );

  throws(() => validateIrBlock({ values, body }), /outside its declaring body or descendants/);
});

test("a child cell cannot escape to its parent body", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const seed = values.const(7);
  const builder = new RegionBuilder(values);
  let cell!: CellRef;

  builder.if(condition, (then) => {
    cell = then.cell(seed);
  });
  builder.push(cellReadNode(values.addNodeOutput(), cell));
  builder.finish({ kind: "dispatch", targetEip: seed });

  throws(
    () => validateIrBlock({ values, body: builder.build() }),
    /outside its declaring body or descendants/
  );
});

test("a cell declared outside a loop can be written in a nested loop arm", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const seed = values.const(7);
  const update = values.const(6);
  const builder = new RegionBuilder(values);
  const cell = builder.cell(seed);

  builder.loop([], (loop) => {
    loop.if(condition, (arm) => arm.write(cell, update));
  });
  builder.finish({ kind: "dispatch", targetEip: seed });

  doesNotThrow(() => validateIrBlock({ values, body: builder.build() }));
});

test("a hand-assembled body declares cell scope by its seed node alone", () => {
  // One regime: raw bodies validate under the same structural rule as
  // builder-built ones — the seed write is the declaration.
  const values = new ValueTable();
  const seed = values.const(7);
  const cell = testCell();

  doesNotThrow(
    () => validateIrBlock(entryBlock(values, [
      cellWrite.create(
        { cell, value: seed, initialization: "seed" }
      ),
      cellReadNode(values.addNodeOutput(), cell),
      finishDispatch(seed)
    ]))
  );
});

test("a hand-assembled nested body may use an ancestor cell", () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const seed = values.const(7);
  const cell = builder.cell(seed);
  const rawChild: Body = {
    nodes: [cellReadNode(values.addNodeOutput(), cell)]
  };

  builder.push(ifControl.create({
    condition: values.external(0),
    thenBody: rawChild
  }));
  builder.finish({ kind: "dispatch", targetEip: seed });

  doesNotThrow(() => validateIrBlock({ values, body: builder.build() }));
});

test("a loopContinue outside any loop body is rejected", () => {
  throws(
    () => validateIrBlock(blockWith([
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
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: {
              nodes: [loopContinueControl.create({ updates: [] })]
            }
          }),
          finishDispatch0
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
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: {
              nodes: [loopContinueControl.create({ updates: [loopInput] })]
            }
          }),
          finishDispatch0
        ])
      )
  );
});

test("a carried cell whose input is not a loopInput value is rejected", () => {
  const values = new ValueTable();
  const seed = values.const(3);

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput: seed }],
            body: {
              nodes: [loopContinueControl.create({ updates: [seed] })]
            }
          }),
          finishDispatch0
        ])
      ),
    /is not a loopInput value/
  );
});

test("used and unused node outputs without producers are rejected", () => {
  const unusedValues = new ValueTable();

  unusedValues.addNodeOutput();
  throws(
    () => validateIrBlock(entryBlock(unusedValues, [finishExit(unusedValues)])),
    /node output \d+ has no producer/
  );

  const usedValues = new ValueTable();
  const used = usedValues.addNodeOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(usedValues, [
          resourceWriteNode(usedValues, 0, used),
          finishExit(usedValues)
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
    () => validateIrBlock(entryBlock(constValues, [
      refinedResourceReadNode(constValues, constant),
      finishExit(constValues)
    ])),
    /producer output \d+ is not a nodeOutput value/
  );

  const compoundValues = new ValueTable();
  compoundValues.const(0);
  const compound = compoundValues.binary("add", compoundValues.external(0), compoundValues.const(1));

  throws(
    () => validateIrBlock(entryBlock(compoundValues, [
      refinedResourceReadNode(compoundValues, compound),
      finishExit(compoundValues)
    ])),
    /producer output \d+ is not a nodeOutput value/
  );

  const loopValues = new ValueTable();
  loopValues.const(0);
  const loopInput = loopValues.addLoopInput();

  throws(
    () => validateIrBlock(entryBlock(loopValues, [
      refinedResourceReadNode(loopValues, loopInput),
      finishExit(loopValues)
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
      validateIrBlock(
        entryBlock(opValues, [
          resourceReadNode(opValues, opOutput, 0),
          resourceReadNode(opValues, opOutput, 0),
          finishExit(opValues)
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
      validateIrBlock(
        entryBlock(mixedValues, [
          resourceReadNode(mixedValues, mixedOutput, 0),
          switchControl.create({
            selector,
            output: mixedOutput,
            cases: [{ match: 0, body: { nodes: [], result } }],
            defaultBody: { nodes: [], result }
          }),
          finishExit(mixedValues)
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
      validateIrBlock(
        entryBlock(directValues, [
          resourceWriteNode(directValues, 0, directOutput),
          resourceReadNode(directValues, directOutput, 0),
          finishExit(directValues)
        ])
      ),
    /node output \d+.*does not dominate/
  );

  const values = new ValueTable();
  values.const(0);
  const output = values.addNodeOutput();
  const compound = values.binary("add", output, values.external(0));

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          resourceWriteNode(values, 0, compound),
          resourceReadNode(values, output, 0),
          finishExit(values)
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
      validateIrBlock(
        entryBlock(values, [
          ifControl.create({
            condition,
            thenBody: { nodes: [resourceReadNode(values, output, 0)] },
            elseBody: { nodes: [resourceWriteNode(values, 0, output)] }
          }),
          finishExit(values)
        ])
      ),
    /node output \d+.*does not dominate/
  );
});

test("one Body object cannot be reused under multiple controls", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const shared: Body = { nodes: [] };

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          ifControl.create({ condition, thenBody: shared }),
          ifControl.create({ condition, thenBody: shared }),
          finishExit(values)
        ])
      ),
    /reuses a Body object that already has an owner/
  );
});

test("a loop input is scoped to its owning loop body", () => {
  const values = new ValueTable();
  const seed = values.const(0);
  const loopInput = values.addLoopInput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          resourceWriteNode(values, 0, loopInput),
          finishExit(values)
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
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          finishExit(values)
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
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [{ seed, loopInput }],
            body: { nodes: [] }
          }),
          loopControl.create({
            carried: [],
            body: { nodes: [resourceWriteNode(values, 0, loopInput)] }
          }),
          finishExit(values)
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
      validateIrBlock(
        entryBlock(values, [
          loopControl.create({
            carried: [],
            body: { nodes: [resourceReadNode(values, output, 0)] }
          }),
          resourceWriteNode(values, 0, output),
          finishExit(values)
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
      validateIrBlock(
        entryBlock(selectorValues, [
          switchControl.create({
            selector: selectorOutput,
            output: selectorOutput,
            cases: [{ match: 0, body: { nodes: [], result: selectorResult } }],
            defaultBody: { nodes: [], result: selectorResult }
          }),
          finishExit(selectorValues)
        ])
      ),
    /switch operand \d+ created after its output/
  );

  const resultValues = new ValueTable();
  const resultSelector = resultValues.const(0);
  const resultOutput = resultValues.addNodeOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(resultValues, [
          switchControl.create({
            selector: resultSelector,
            output: resultOutput,
            cases: [{ match: 0, body: { nodes: [], result: resultOutput } }],
            defaultBody: { nodes: [], result: resultSelector }
          }),
          finishExit(resultValues)
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
    validateIrBlock(
      entryBlock(values, [
        switchControl.create({
          selector,
          output,
          cases: [{ match: 0, body: { nodes: [], result } }],
          defaultBody: { nodes: [], result }
        }),
        resourceWriteNode(values, 0, output),
        finishExit(values)
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
    validateIrBlock(
      entryBlock(values, [
        resourceReadNode(values, output, 0),
        ifControl.create({
          condition,
          thenBody: { nodes: [resourceWriteNode(values, 0, output)] }
        }),
        switchControl.create({
          selector: condition,
          output: switchOutput,
          cases: [{ match: 0, body: { nodes: [], result: output } }],
          defaultBody: { nodes: [], result: fallback }
        }),
        loopControl.create({
          carried: [],
          body: { nodes: [resourceWriteNode(values, 0, output)] }
        }),
        finishExit(values)
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
    validateIrBlock(
      entryBlock(values, [
        switchControl.create({
          selector,
          output: switchOutput,
          cases: [
            {
              match: 0,
              body: {
                nodes: [resourceReadNode(values, armOutput, 0)],
                result: formula
              }
            }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        finishExit(values)
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
      validateIrBlock(
        entryBlock(values, [
          memoryReadOperation(output, address, 32),
          finishExit(values)
        ])
      ),
    /producer operand \d+ created after its output/
  );
});

test("exported outputs are validated at the root body boundary", () => {
  const validValues = new ValueTable();
  validValues.const(0);
  const validOutput = validValues.addNodeOutput();
  const validBlock = entryBlock(validValues, [
    resourceReadNode(validValues, validOutput, 0),
    finishExit(validValues)
  ]);

  doesNotThrow(() => validateIrBlock(validBlock, { exportedOutputs: [validOutput] }));

  const escapingValues = new ValueTable();
  const condition = escapingValues.const(1);
  escapingValues.const(0);
  const escapingOutput = escapingValues.addNodeOutput();
  const escapingBlock = entryBlock(escapingValues, [
    ifControl.create({
      condition,
      thenBody: {
        nodes: [resourceReadNode(escapingValues, escapingOutput, 0)]
      }
    }),
    finishExit(escapingValues)
  ]);

  throws(
    () => validateIrBlock(escapingBlock, { exportedOutputs: [escapingOutput] }),
    /node output \d+.*does not dominate exported output/
  );
});
