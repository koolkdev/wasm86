import { doesNotThrow, ok, throws } from "node:assert";
import { test } from "node:test";

import { maxSwitchMatch, type Action, type SwitchAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { validateIrBlock } from "#ir/validate.js";
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
  ValueId
} from "#compiler/ir/values/types.js";

function blockWith(
  actions: readonly Action[] | ((values: ValueTable) => readonly Action[])
): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 10; value += 1) {
    values.const(value);
  }

  return {
    body: { actions: typeof actions === "function" ? actions(values) : actions },
    values
  };
}

function entryBlock(values: ValueTable, actions: readonly Action[]): IrBlock {
  return {
    values,
    body: { actions }
  };
}

function finishDispatch(targetEip: number): Action {
  return { kind: "finish", finish: { kind: "dispatch", targetEip: valueId(targetEip) } };
}

function finishExit(values: ValueTable): Action {
  return { kind: "finish", finish: { kind: "exit", result: values.const64(0n) } };
}

const finishDispatch0 = finishDispatch(0);

function testCell(): CellRef<"i32"> {
  return new CellRef("i32");
}

function cellReadAction(
  output: ValueId,
  cell: CellRef
): Action {
  return { kind: "op", output, op: cellRead.create({ cell }) };
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

function testRead(output: ValueId): Action {
  return {
    kind: "op",
    output,
    op: resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        valueId(0),
        0,
        32
      )
    })
  };
}

function memoryRead(
  output: ValueId,
  address: ValueId,
  width: IntegerWidth
): Action {
  const range: ByteRange = {
    basis: { kind: "dynamic", origin: new DynamicByteOriginRef() },
    slice: { byteOffset: 0, byteLength: width / 8 }
  };

  return {
    kind: "op",
    output,
    op: resourceRead.create({
      source: resourceOperand(range, address, 0, width)
    })
  };
}

function testWrite(value: ValueId | number): Action {
  return {
    kind: "op",
    op: resourceWrite.create({
      destination: resourceOperand(
        { basis: { kind: "resource" } },
        valueId(0),
        0,
        32
      ),
      value: valueId(value)
    })
  };
}

function blockWithResourceOperation(
  values: ValueTable,
  operation: ResourceOperation
): IrBlock {
  const operationAction: Action = operation.result === undefined
    ? { kind: "op", op: operation }
    : {
        kind: "op",
        op: operation,
        output: operation.result.type === "i64"
          ? values.addActionOutput64()
          : values.addActionOutput(operation.result.bounds)
      };

  return entryBlock(values, [operationAction, finishExit(values)]);
}

test("a body ending with a finish exit validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith((values) => [finishExit(values)])));
});

test("a body ending with a finish dispatch validates", () => {
  doesNotThrow(() => validateIrBlock(blockWith([finishDispatch0])));
});

test("an implicit fragment body end validates only when allowed", () => {
  const block = blockWith([testWrite(0)]);

  throws(() => validateIrBlock(block), /root body does not complete/);
  doesNotThrow(() => validateIrBlock(block, { allowImplicitEntryFallthrough: true }));
});

test("a terminal if with both bodies complete validates", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith([
        {
          kind: "if",
          condition: valueId(0),
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishDispatch(1)] }
        }
      ])
    )
  );
});

test("an action after the finish exit terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
          finishExit(values),
          testWrite(0)
        ])
      ),
    /has actions after its terminal finish action/
  );
});

test("an action after a finish dispatch terminator is rejected", () => {
  throws(
    () =>
      validateIrBlock(blockWith([finishDispatch0, testWrite(0)])),
    /has actions after its terminal finish action/
  );
});

test("an action after a terminal if is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
        {
          kind: "if",
          condition: valueId(0),
          thenBody: { actions: [finishDispatch0] },
          elseBody: { actions: [finishExit(values)] }
        },
          testWrite(0)
        ])
      ),
    /has actions after its terminal if action/
  );
});

test("a body that does not complete is rejected", () => {
  throws(
    () => validateIrBlock(blockWith([testWrite(0)])),
    /root body does not complete/
  );
});

test("dispatch target must be a known value", () => {
  throws(
    () => validateIrBlock(blockWith([finishDispatch(99)])),
    /unknown value id 99/
  );
});

test("op action output bounds must match the op signature", () => {
  const missingBounds = new ValueTable();
  const missingBoundsAddress = missingBounds.const(0);
  const missingBoundsOutput = missingBounds.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(missingBounds, [
          memoryRead(missingBoundsOutput, missingBoundsAddress, 8),
          finishExit(missingBounds)
        ])
      ),
    /resource\.read op action output \d+ has the wrong bounds/
  );

  const overlyNarrow = new ValueTable();
  const overlyNarrowAddress = overlyNarrow.const(0);
  const overlyNarrowOutput = overlyNarrow.addActionOutput(fitsUnsigned(8));

  throws(
    () =>
      validateIrBlock(
        entryBlock(overlyNarrow, [
          memoryRead(overlyNarrowOutput, overlyNarrowAddress, 32),
          finishExit(overlyNarrow)
        ])
      ),
    /resource\.read op action output \d+ has the wrong bounds/
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
  });
  const write = resourceWrite.create({
    destination: resourceOperand(range, address, 4, 16),
    value
  });
  const output = values.addActionOutput(signExtended(16));

  doesNotThrow(() => validateIrBlock(entryBlock(values, [
    { kind: "op", op: read, output },
    { kind: "op", op: write },
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
        })
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
    });
    const operation = { ...read, signed: true } as ResourceOperation;

    throws(
      () => validateIrBlock(blockWithResourceOperation(values, operation)),
      /signedness is valid only for a narrow read/
    );
  }

  {
    const values = new ValueTable();
    const address = values.const(0);
    const operation = resourceRead.create({
      source: resourceOperand(
        { basis: { kind: "resource" } },
        address,
        0,
        64 as IntegerWidth
      )
    });

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
    });

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
    });

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
  });

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
  });

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
    });
    const forged = {
      ...read,
      effects: { reads: [], writes: [read.effect] }
    } as ResourceOperation;

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
    const forged = {
      ...write,
      effects: { reads: [write.effect], writes: [] }
    } as ResourceOperation;

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
    });
    const structurallyEqualEffect = {
      ...read.effect,
      range: { ...read.effect.range }
    };
    const forged = {
      ...read,
      effects: { reads: [structurallyEqualEffect], writes: [] }
    } as ResourceOperation;

    throws(
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
      /effects must read its exact resource effect and write nothing/
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
    });
    const forged = { ...read, inputs: [] } as ResourceOperation;

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
    const forged = {
      ...write,
      inputs: [
        write.inputs[0],
        { value, type: "i64" }
      ]
    } as ResourceOperation;

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
    });
    const forged = { ...read, result: undefined } as unknown as ResourceOperation;

    throws(
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
      /must have an i32 result/
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
      ),
      mode: { kind: "signed" }
    });
    const forged = {
      ...read,
      result: { type: "i32", bounds: fitsUnsigned(7) }
    } as ResourceOperation;

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
    const forged = {
      ...write,
      result: { type: "i32" }
    } as unknown as ResourceOperation;

    throws(
      () => validateIrBlock(blockWithResourceOperation(values, forged)),
      /must not have a result/
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
  });

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
  });

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
  });

  throws(
    () => validateIrBlock(blockWithResourceOperation(malformedValues, malformed)),
    /result bounds are malformed/
  );
});

test("a nested dispatch is generic control", () => {
  doesNotThrow(() =>
    validateIrBlock(
      blockWith((values) => [{
        kind: "if",
        condition: valueId(0),
        thenBody: { actions: [finishDispatch0] },
        elseBody: { actions: [finishExit(values)] }
      }])
    )
  );
});

function switchBlock(
  buildOverrides: Partial<SwitchAction> | ((values: ValueTable) => Partial<SwitchAction>)
): IrBlock {
  const values = new ValueTable();

  for (let value = 0; value < 5; value += 1) {
    values.const(value);
  }

  const overrides = typeof buildOverrides === "function"
    ? buildOverrides(values)
    : buildOverrides;
  const action: SwitchAction = {
    kind: "switch",
    selector: valueId(0),
    output: values.addActionOutput(),
    cases: [
      { match: 0, body: { actions: [], result: valueId(2) } },
      { match: 2, body: { actions: [], result: valueId(3) } }
    ],
    defaultBody: { actions: [], result: valueId(4) },
    ...overrides
  };

  return entryBlock(values, [action, finishExit(values)]);
}

test("a switch whose bodies all carry results validates", () => {
  doesNotThrow(() => validateIrBlock(switchBlock({})));
});

test("an escaping switch body is rejected until a producer arrives", () => {
  throws(
    () =>
      validateIrBlock(switchBlock((values) => ({
        cases: [{ match: 0, body: { actions: [finishExit(values)] } }]
      }))),
    /case\[0\] must carry a result/
  );
});

test("a result on the root body is rejected", () => {
  const values = new ValueTable();
  const result = values.const(1);

  throws(
    () => validateIrBlock({ values, body: { actions: [finishExit(values)], result } }),
    /body carries a result without an owner output/
  );
});

test("a result under an output-less owner is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        blockWith((values) => [
          {
            kind: "if",
            condition: valueId(0),
            thenBody: { actions: [finishExit(values)], result: valueId(1) }
          },
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
        cases: [{ match: 0, body: { actions: [finishExit(values)], result: valueId(2) } }]
      }))),
    /case\[0\] carries a result but completes/
  );
});

test("an output-owner body that neither escapes nor carries a result is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ defaultBody: { actions: [] } })),
    /default must carry a result/
  );
});

test("a duplicate switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(
        switchBlock({
          cases: [
            { match: 1, body: { actions: [], result: valueId(2) } },
            { match: 1, body: { actions: [], result: valueId(3) } }
          ]
        })
      ),
    /has a duplicate case match 1/
  );
});

test("a negative switch case match is rejected", () => {
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: -1, body: { actions: [], result: valueId(2) } }] })),
    /case match -1 is not an integer in \[0, 255\]/
  );
});

test("a switch case match beyond the dense-table bound is rejected", () => {
  doesNotThrow(() =>
    validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch, body: { actions: [], result: valueId(2) } }] }))
  );
  throws(
    () =>
      validateIrBlock(switchBlock({ cases: [{ match: maxSwitchMatch + 1, body: { actions: [], result: valueId(2) } }] })),
    /case match 256 is not an integer in \[0, 255\]/
  );
});

test("a switch without a default body is rejected", () => {
  const missingDefault = switchBlock({ defaultBody: undefined as unknown as Body });

  throws(
    () => validateIrBlock(missingDefault),
    /is missing its default body/
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
        {
          kind: "loop",
          carried: [{ seed, loopInput }],
          body: {
            actions: [
              { kind: "if", condition: update, thenBody: { actions: [{ kind: "loopContinue", updates: [update] }] } },
              testWrite(update)
            ]
          }
        },
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
  const seedAction = body.actions[0];
  const readAction = body.actions[1];
  const finishAction = body.actions[2];

  ok(seedAction !== undefined);
  ok(readAction !== undefined);
  ok(finishAction !== undefined);

  (body.actions as Action[]).splice(0, 3, readAction, seedAction, finishAction);

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

  builder.operation(
    cellWrite.create({ cell, value: seed, initialization: "seed" })
  );
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

  (body.actions as Action[]).splice(0, 1);

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
  const foreignRead = source.build().actions[1];

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
  const branch = body.actions[0];

  if (branch?.kind !== "if" || branch.elseBody === undefined) {
    throw new Error("test branch did not build both arms");
  }
  (branch.elseBody.actions as Action[]).push(
    cellReadAction(values.addActionOutput(), cell)
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
  builder.push(cellReadAction(values.addActionOutput(), cell));
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

test("a hand-assembled body declares cell scope by its seed action alone", () => {
  // One regime: raw bodies validate under the same structural rule as
  // builder-built ones — the seed write is the declaration.
  const values = new ValueTable();
  const seed = values.const(7);
  const cell = testCell();

  doesNotThrow(
    () => validateIrBlock(entryBlock(values, [
      {
        kind: "op",
        op: cellWrite.create({ cell, value: seed, initialization: "seed" })
      },
      cellReadAction(values.addActionOutput(), cell),
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
    actions: [cellReadAction(values.addActionOutput(), cell)]
  };

  builder.push({ kind: "if", condition: values.external(0), thenBody: rawChild });
  builder.finish({ kind: "dispatch", targetEip: seed });

  doesNotThrow(() => validateIrBlock({ values, body: builder.build() }));
});

test("a loopContinue outside any loop body is rejected", () => {
  throws(
    () => validateIrBlock(blockWith([{ kind: "loopContinue", updates: [] }])),
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
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [{ kind: "loopContinue", updates: [] }] }
          },
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
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [{ kind: "loopContinue", updates: [loopInput] }] }
          },
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
          {
            kind: "loop",
            carried: [{ seed, loopInput: seed }],
            body: { actions: [{ kind: "loopContinue", updates: [seed] }] }
          },
          finishDispatch0
        ])
      ),
    /is not a loopInput value/
  );
});

test("used and unused action outputs without producers are rejected", () => {
  const unusedValues = new ValueTable();

  unusedValues.addActionOutput();
  throws(
    () => validateIrBlock(entryBlock(unusedValues, [finishExit(unusedValues)])),
    /action output \d+ has no producer/
  );

  const usedValues = new ValueTable();
  const used = usedValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(usedValues, [
          testWrite(used),
          finishExit(usedValues)
        ])
      ),
    /action output \d+ has no producer/
  );
});

test("producer outputs must name actionOutput values", () => {
  const constValues = new ValueTable();
  constValues.const(0);
  const constant = constValues.const(1);

  throws(
    () => validateIrBlock(entryBlock(constValues, [
      testRead(constant),
      finishExit(constValues)
    ])),
    /producer output \d+ is not an actionOutput value/
  );

  const compoundValues = new ValueTable();
  const compound = compoundValues.binary("add", compoundValues.external(0), compoundValues.const(1));

  throws(
    () => validateIrBlock(entryBlock(compoundValues, [
      testRead(compound),
      finishExit(compoundValues)
    ])),
    /producer output \d+ is not an actionOutput value/
  );

  const loopValues = new ValueTable();
  loopValues.const(0);
  const loopInput = loopValues.addLoopInput();

  throws(
    () => validateIrBlock(entryBlock(loopValues, [
      testRead(loopInput),
      finishExit(loopValues)
    ])),
    /producer output \d+ is not an actionOutput value/
  );
});

test("duplicate op producers and op-vs-switch producers are rejected", () => {
  const opValues = new ValueTable();
  opValues.const(0);
  const opOutput = opValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(opValues, [
          testRead(opOutput),
          testRead(opOutput),
          finishExit(opValues)
        ])
      ),
    /action output \d+ has more than one producer/
  );

  const mixedValues = new ValueTable();
  const selector = mixedValues.const(0);
  const result = mixedValues.const(1);
  const mixedOutput = mixedValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(mixedValues, [
          testRead(mixedOutput),
          {
            kind: "switch",
            selector,
            output: mixedOutput,
            cases: [{ match: 0, body: { actions: [], result } }],
            defaultBody: { actions: [], result }
          },
          finishExit(mixedValues)
        ])
      ),
    /action output \d+ has more than one producer/
  );
});

test("a same-body compound use before its producer is rejected", () => {
  const directValues = new ValueTable();
  directValues.const(0);
  const directOutput = directValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(directValues, [
          testWrite(directOutput),
          testRead(directOutput),
          finishExit(directValues)
        ])
      ),
    /action output \d+.*does not dominate/
  );

  const values = new ValueTable();
  values.const(0);
  const output = values.addActionOutput();
  const compound = values.binary("add", output, values.external(0));

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          testWrite(compound),
          testRead(output),
          finishExit(values)
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("an action output cannot be used from a sibling body", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const output = values.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "if",
            condition,
            thenBody: { actions: [testRead(output)] },
            elseBody: { actions: [testWrite(output)] }
          },
          finishExit(values)
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("one Body object cannot be reused under multiple control actions", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const shared: Body = { actions: [] };

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          { kind: "if", condition, thenBody: shared },
          { kind: "if", condition, thenBody: shared },
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
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [] }
          },
          testWrite(loopInput),
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
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [] }
          },
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [] }
          },
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
          {
            kind: "loop",
            carried: [{ seed, loopInput }],
            body: { actions: [] }
          },
          {
            kind: "loop",
            carried: [],
            body: { actions: [testWrite(loopInput)] }
          },
          finishExit(values)
        ])
      ),
    /loop input \d+ is used outside its owning loop body/
  );
});

test("a loop-body action output cannot escape directly after the loop", () => {
  const values = new ValueTable();
  values.const(0);
  const output = values.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          {
            kind: "loop",
            carried: [],
            body: { actions: [testRead(output)] }
          },
          testWrite(output),
          finishExit(values)
        ])
      ),
    /action output \d+.*does not dominate/
  );
});

test("a switch output cannot be its own selector or arm result", () => {
  const selectorValues = new ValueTable();
  const selectorResult = selectorValues.const(1);
  const selectorOutput = selectorValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(selectorValues, [
          {
            kind: "switch",
            selector: selectorOutput,
            output: selectorOutput,
            cases: [{ match: 0, body: { actions: [], result: selectorResult } }],
            defaultBody: { actions: [], result: selectorResult }
          },
          finishExit(selectorValues)
        ])
      ),
    /switch selector \d+ created after its output/
  );

  const resultValues = new ValueTable();
  const resultSelector = resultValues.const(0);
  const resultOutput = resultValues.addActionOutput();

  throws(
    () =>
      validateIrBlock(
        entryBlock(resultValues, [
          {
            kind: "switch",
            selector: resultSelector,
            output: resultOutput,
            cases: [{ match: 0, body: { actions: [], result: resultOutput } }],
            defaultBody: { actions: [], result: resultSelector }
          },
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
  const output = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        {
          kind: "switch",
          selector,
          output,
          cases: [{ match: 0, body: { actions: [], result } }],
          defaultBody: { actions: [], result }
        },
        testWrite(output),
        finishExit(values)
      ])
    )
  );
});

test("an ancestor producer can feed nested if, switch-result, and loop-body uses", () => {
  const values = new ValueTable();
  const condition = values.const(1);
  const output = values.addActionOutput();
  const fallback = values.const(0);
  const switchOutput = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        testRead(output),
        {
          kind: "if",
          condition,
          thenBody: { actions: [testWrite(output)] }
        },
        {
          kind: "switch",
          selector: condition,
          output: switchOutput,
          cases: [{ match: 0, body: { actions: [], result: output } }],
          defaultBody: { actions: [], result: fallback }
        },
        {
          kind: "loop",
          carried: [],
          body: { actions: [testWrite(output)] }
        },
        finishExit(values)
      ])
    )
  );
});

test("a body-local producer can feed its body result", () => {
  const values = new ValueTable();
  const selector = values.const(0);
  const armOutput = values.addActionOutput();
  const formula = values.binary("add", armOutput, values.const(1));
  const fallback = values.const(7);
  const switchOutput = values.addActionOutput();

  doesNotThrow(() =>
    validateIrBlock(
      entryBlock(values, [
        {
          kind: "switch",
          selector,
          output: switchOutput,
          cases: [
            {
              match: 0,
              body: {
                actions: [testRead(armOutput)],
                result: formula
              }
            }
          ],
          defaultBody: { actions: [], result: fallback }
        },
        finishExit(values)
      ])
    )
  );
});

test("producer operands must have lower value ids than their output", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const address = values.const(0x2000);

  throws(
    () =>
      validateIrBlock(
        entryBlock(values, [
          memoryRead(output, address, 32),
          finishExit(values)
        ])
      ),
    /producer operand \d+ created after its output/
  );
});

test("exported outputs are validated at the root body boundary", () => {
  const validValues = new ValueTable();
  validValues.const(0);
  const validOutput = validValues.addActionOutput();
  const validBlock = entryBlock(validValues, [
    testRead(validOutput),
    finishExit(validValues)
  ]);

  doesNotThrow(() => validateIrBlock(validBlock, { exportedOutputs: [validOutput] }));

  const escapingValues = new ValueTable();
  const condition = escapingValues.const(1);
  const escapingOutput = escapingValues.addActionOutput();
  const escapingBlock = entryBlock(escapingValues, [
    {
      kind: "if",
      condition,
      thenBody: { actions: [testRead(escapingOutput)] }
    },
    finishExit(escapingValues)
  ]);

  throws(
    () => validateIrBlock(escapingBlock, { exportedOutputs: [escapingOutput] }),
    /action output \d+.*does not dominate exported output/
  );
});
