import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#core/instruction/builder.js";
import { flagStateFields } from "#core/flags/layout.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import type { LoopControl } from "#compiler/ir/controls/index.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { validateIrFunction } from "#compiler/ir/validate.js";
import {
  buildInstructionFunction
} from "./instruction-function.js";
import {
  isStateWrite,
  writesStateChannel,
  type StateWriteOperation
} from "./state-operations.js";

const repEip = 0x1000;
const repNextEip = 0x1002;

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

test("loop analysis preserves values captured from the enclosing scope", () => {
  const block = buildInstructionFunction((builder) => {
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
  });

  validateIrFunction(block);
  assertCarries(block, loopIn(block), [gprChannel("ebx")]);
});

test("loop analysis can use a semantic variable created in an enclosing arm", () => {
  const block = buildInstructionFunction((builder) => {
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
  });

  validateIrFunction(block);
});

test("scratch analysis conservatively retains writes from a folded final arm", () => {
  const block = buildInstructionFunction((builder) => {
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
  });

  validateIrFunction(block);
  assertCarries(block, loopIn(block), [gprChannel("ebx")]);
});

test("loop analysis derives register and lazy-flag carries", () => {
  {
    const block = buildInstructionFunction((builder) => {
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
    });

    validateIrFunction(block);
    assertCarries(block, loopIn(block), [gprChannel("eax")]);
  }

  {
    const block = buildInstructionFunction((builder) => {
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
    });

    validateIrFunction(block);
    assertCarries(block, loopIn(block), [
      flagStateFields.lazyKind,
      flagStateFields.lazyA,
      flagStateFields.lazyB
    ]);
  }
});

test("overlapping architectural writes are rejected during carry discovery", () => {
  throws(
    () => buildInstructionFunction((builder) => {
      builder.add(
        (s) => {
          s.loop((loop, values) => {
            loop.write(loop.reg("al"), values.const(1), { width: 8 });
            loop.write(loop.reg("ax"), values.const(2), { width: 16 });
            return values.const(0);
          });
        },
        [],
        loc(repEip, repNextEip)
      );
    }),
    /overlapping state channels/
  );
});

test("semantic variables do not become architectural loop carries", () => {
  const block = buildInstructionFunction((builder) => {
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
  });
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
