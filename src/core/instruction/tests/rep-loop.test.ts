import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import {
  memBinding,
  staticMemSegment
} from "#core/instruction/bindings.js";
import { flagStateFields } from "#core/flags/layout.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import {
  repeCmpsSemantic,
  repeScasSemantic,
  repLodsSemantic,
  repMovsSemantic,
  repStosSemantic
} from "#core/semantics/strings.js";
import type { LoopControl } from "#compiler/ir/controls/index.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import {
  createInstructionFunction
} from "#test/support/instruction-function.js";
import {
  isStateRead,
  isStateWrite,
  writesStateChannel,
  type StateWriteOperation
} from "./state-operations.js";

const repEip = 0x1000;
const repNextEip = 0x1002;

function siOperand(): ReturnType<typeof memBinding> {
  return memBinding(
    { base: "esi", index: undefined, scale: 1, disp: 0 },
    staticMemSegment("ds")
  );
}

function diOperand(): ReturnType<typeof memBinding> {
  return memBinding(
    { base: "edi", index: undefined, scale: 1, disp: 0 },
    staticMemSegment("es")
  );
}

function loopsIn(nodes: readonly RegionNode[]): LoopControl[] {
  return nodes.flatMap((node): LoopControl[] => {
    if (node.kind === "loop") {
      return [node, ...loopsIn(node.body.nodes)];
    }
    return node.nestedBodies.flatMap((nested) => loopsIn(nested.body.nodes));
  });
}

function loopIn(block: FunctionGraph): LoopControl {
  const loops = loopsIn(block.body.nodes);

  strictEqual(loops.length, 1, "instruction has one semantic loop");
  return loops[0]!;
}

function assertCarries(
  block: FunctionGraph,
  loop: LoopControl,
  channels: readonly InstructionStateChannel[]
): void {
  strictEqual(loop.carried.length, channels.length);

  const commits = loop.body.nodes.filter(isStateWrite);

  for (const channel of channels) {
    strictEqual(
      commits.filter((write) =>
        writesStateChannel(block.values, write, channel)
      ).length,
      1,
      `${channel.kind} channel is committed from the loop`
    );
  }
}

test("REP forms carry exactly the architectural channels they update", () => {
  const cases = [
    {
      name: "movs",
      template: repMovsSemantic(32),
      bindings: [siOperand(), diOperand()],
      channels: [
        gprChannel("esi"),
        gprChannel("edi"),
        gprChannel("ecx")
      ]
    },
    {
      name: "stos",
      template: repStosSemantic(32),
      bindings: [diOperand()],
      channels: [gprChannel("edi"), gprChannel("ecx")]
    },
    {
      name: "lods",
      template: repLodsSemantic(16),
      bindings: [siOperand()],
      channels: [
        gprChannel("ax"),
        gprChannel("esi"),
        gprChannel("ecx")
      ]
    },
    {
      name: "cmps",
      template: repeCmpsSemantic(8),
      bindings: [siOperand(), diOperand()],
      channels: [
        gprChannel("esi"),
        gprChannel("edi"),
        gprChannel("ecx"),
        flagStateFields.lazyKind,
        flagStateFields.lazyA,
        flagStateFields.lazyB
      ]
    },
    {
      name: "scas",
      template: repeScasSemantic(8),
      bindings: [diOperand()],
      channels: [
        gprChannel("edi"),
        gprChannel("ecx"),
        flagStateFields.lazyKind,
        flagStateFields.lazyA,
        flagStateFields.lazyB
      ]
    }
  ] as const;

  for (const entry of cases) {
    const builder = createInstructionFunction();

    builder.add(
      entry.template,
      entry.bindings,
      loc(repEip, repNextEip)
    );

    const block = builder.finish();

    validateIrFunction(block);
    assertCarries(block, loopIn(block), entry.channels);
  }
});

test("REP iteration uses carried values instead of per-unit state traffic", () => {
  const builder = createInstructionFunction();

  builder.add(
    repMovsSemantic(32),
    [siOperand(), diOperand()],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = loopIn(block);
  const backEdgeIndex = loop.body.nodes.findIndex(
    (node) =>
      node.kind === "if" &&
      node.thenBody.nodes.some((nested) => nested.kind === "loopContinue")
  );

  ok(backEdgeIndex >= 0, "loop body has a conditional back edge");
  strictEqual(
    loop.body.nodes.slice(0, backEdgeIndex + 1).filter(
      (node) => isStateRead(node) || isStateWrite(node)
    ).length,
    0,
    "the iteration path does not reload or commit carried state"
  );

  const backEdge = loop.body.nodes[backEdgeIndex]!;

  ok(backEdge.kind === "if");
  const continuation = backEdge.thenBody.nodes.find(
    (node) => node.kind === "loopContinue"
  );

  ok(continuation !== undefined);
  strictEqual(continuation.updates.length, loop.carried.length);
  assertCarries(block, loop, [
    gprChannel("esi"),
    gprChannel("edi"),
    gprChannel("ecx")
  ]);
});

test("loop analysis preserves values captured from the enclosing scope", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      const outer = s.read(s.reg("eax"), { width: 32 });
      const offset = v.const(7);

      s.loop((loop, loopValues) => {
        loop.write(
          loop.reg("ebx"),
          loopValues.binary("add", outer, offset),
          { width: 32 }
        );
        return loopValues.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();

  validateIrFunction(block);
  assertCarries(block, loopIn(block), [gprChannel("ebx")]);
});

test("loop analysis can use a semantic variable created in an enclosing arm", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s) => {
      s.if(s.read(s.reg("eax"), { width: 32 }), (then, values) => {
        const counter = then.var(values.const(2));

        then.loop((loop, loopValues) => {
          const next = loopValues.binary(
            "sub",
            loop.read(counter, { width: 32 }),
            loopValues.const(1)
          );

          loop.write(counter, next, { width: 32 });
          return loopValues.compare(
            32,
            "ne",
            next,
            loopValues.const(0)
          );
        });
        then.read(counter, { width: 32 });
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  validateIrFunction(builder.finish());
});

test("scratch analysis conservatively retains writes from a folded final arm", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, v) => {
      s.write(s.reg("eax"), v.const(0), { width: 32 });
      s.loop((loop, loopValues) => {
        loop.if(
          loop.read(loop.reg("eax"), { width: 32 }),
          (then) => {
            then.write(
              then.reg("ebx"),
              loopValues.const(1),
              { width: 32 }
            );
          }
        );
        return loopValues.const(0);
      });
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();

  validateIrFunction(block);
  assertCarries(block, loopIn(block), [gprChannel("ebx")]);
});

test("loop analysis derives register and lazy-flag carries", () => {
  {
    const builder = createInstructionFunction();

    builder.add(
      (s) => {
        s.loop((loop, values) => {
          loop.write(
            loop.reg("eax"),
            values.const(0),
            { width: 32 }
          );
          return values.const(0);
        });
      },
      [],
      loc(repEip, repNextEip)
    );

    const block = builder.finish();

    validateIrFunction(block);
    assertCarries(block, loopIn(block), [gprChannel("eax")]);
  }

  {
    const builder = createInstructionFunction();

    builder.add(
      (s) => {
        s.loop((loop, values) => {
          loop.writeStatusFlagsSource(subFlagSource({
            width: 32,
            left: values.const(0),
            right: values.const(0),
            result: values.const(0)
          }));
          return values.const(0);
        });
      },
      [],
      loc(repEip, repNextEip)
    );

    const block = builder.finish();

    validateIrFunction(block);
    assertCarries(block, loopIn(block), [
      flagStateFields.lazyKind,
      flagStateFields.lazyA,
      flagStateFields.lazyB
    ]);
  }
});

test("overlapping architectural writes are rejected during carry discovery", () => {
  const builder = createInstructionFunction();

  throws(
    () => builder.add(
      (s) => {
        s.loop((loop, values) => {
          loop.write(loop.reg("al"), values.const(1), { width: 8 });
          loop.write(loop.reg("ax"), values.const(2), { width: 16 });
          return values.const(0);
        });
      },
      [],
      loc(repEip, repNextEip)
    ),
    /overlapping state channels/
  );
});

test("semantic variables do not become architectural loop carries", () => {
  const builder = createInstructionFunction();

  builder.add(
    (s, values) => {
      const counter = s.var(values.const(3));

      s.loop((loop, loopValues) => {
        const next = loopValues.binary(
          "sub",
          loop.read(counter, { width: 32 }),
          loopValues.const(1)
        );

        loop.write(counter, next, { width: 32 });
        return loopValues.compare(
          32,
          "ne",
          next,
          loopValues.const(0)
        );
      });
      s.write(
        s.reg("eax"),
        s.read(counter, { width: 32 }),
        { width: 32 }
      );
    },
    [],
    loc(repEip, repNextEip)
  );

  const block = builder.finish();
  const loop = loopIn(block);

  validateIrFunction(block);
  strictEqual(loop.carried.length, 0);

  const eaxWrites = block.body.nodes.filter(
    (node): node is StateWriteOperation =>
      isStateWrite(node) &&
      writesStateChannel(block.values, node, gprChannel("eax"))
  );

  strictEqual(eaxWrites.length, 1);
});
