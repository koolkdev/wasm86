import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { staticInstructionLocation as loc } from "#instructions/lowering/builder.js";
import { flagStateFields } from "#core/flags/layout.js";
import { subFlagSource } from "#core/flags/lazy/sources.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { gprChannel } from "#core/state/channels.js";
import { Control, type LoopControl } from "#compiler/function/control.js";
import type { FunctionBody } from "#compiler/function/body.js";
import type { RegionNode } from "#compiler/function/region.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { integer, i32, nonzero, u8, u16 } from "#compiler/function/values.js";
import { buildInstructionFunction } from "./instruction-function.js";
import {
  isStateWrite,
  readsStateChannel,
  writesStateChannel,
  type StateWriteOperation
} from "./state-operations.js";

const repEip = 0x1000;
const repNextEip = 0x1002;

type FunctionGraphFixture = Pick<FunctionBody, "entry" | "values">;

function loopsIn(nodes: readonly RegionNode[]): LoopControl[] {
  return nodes.flatMap((node): LoopControl[] => {
    if (node.kind === "loop") {
      return [node, ...loopsIn(node.body.nodes)];
    }
    return node.category === "control"
      ? Control.describe(node).regions.flatMap((nested) => loopsIn(nested.body.nodes))
      : [];
  });
}

function loopIn(block: FunctionGraphFixture): LoopControl {
  const loops = loopsIn(block.entry.nodes);

  strictEqual(loops.length, 1, "instruction has one semantic loop");
  return loops[0]!;
}

function assertCarries(loop: LoopControl, channels: readonly InstructionStateChannel[]): void {
  strictEqual(loop.carried.length, channels.length);

  const commits = loop.body.nodes.filter(isStateWrite);

  for (const channel of channels) {
    strictEqual(
      commits.filter((write) => writesStateChannel(write, channel)).length,
      1,
      `${channel.kind} channel is committed from the loop`
    );
  }
}

test("loop analysis preserves values captured from the enclosing scope", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      (s) => {
        const outer = s.read(s.reg("eax"));
        const offset = i32(7);

        s.loop((loop) => {
          loop.write(loop.reg("ebx"), outer.add(offset));
          return integer(1, 0);
        });
      },
      [],
      loc(repEip, repNextEip)
    );
  });

  planWasmFunction(lowerWasmFunction(block));
  assertCarries(loopIn(block), [gprChannel("ebx")]);
});

test("a non-carried state read belongs to the loop entry and remains usable afterward", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      (s) => {
        s.loop((loop) => {
          loop.read(loop.reg("eax"));
          return integer(1, 0);
        });
        s.write(s.reg("ebx"), s.read(s.reg("eax")));
      },
      [],
      loc(repEip, repNextEip)
    );
  });
  const loop = loopIn(block);
  const eax = gprChannel("eax");

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(
    block.entry.nodes.some((node) => readsStateChannel(node, eax)),
    true
  );
  strictEqual(
    loop.body.nodes.some((node) => readsStateChannel(node, eax)),
    false
  );
});

test("loop analysis can use a semantic variable created in an enclosing arm", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      (s) => {
        s.if(nonzero(s.read(s.reg("eax"))), (then) => {
          const counter = then.var(i32(2));

          then.loop((loop) => {
            const next = loop.read(counter).sub(1);

            loop.write(counter, next);
            return next.ne(0);
          });
          then.read(counter);
        });
      },
      [],
      loc(repEip, repNextEip)
    );
  });

  planWasmFunction(lowerWasmFunction(block));
});

test("scratch analysis conservatively retains writes from a folded final arm", () => {
  const block = buildInstructionFunction((builder) => {
    builder.add(
      (s) => {
        s.write(s.reg("eax"), i32(0));
        s.loop((loop) => {
          loop.if(nonzero(loop.read(loop.reg("eax"))), (then) => {
            then.write(then.reg("ebx"), i32(1));
          });
          return integer(1, 0);
        });
      },
      [],
      loc(repEip, repNextEip)
    );
  });

  planWasmFunction(lowerWasmFunction(block));
  assertCarries(loopIn(block), [gprChannel("ebx")]);
});

test("input-backed flag reads stay rejected in nested loop arms", () => {
  throws(
    () =>
      buildInstructionFunction((builder) => {
        builder.add(
          (s) => {
            s.loop((loop) => {
              const condition = nonzero(loop.read(loop.reg("eax")));

              loop.if(condition, (arm) => {
                arm.readFlag("CF");
              });
              return integer(1, 0);
            });
          },
          [],
          loc(repEip, repNextEip)
        );
      }),
    /input-backed status flag reads inside a loop body/
  );
});

test("loop analysis derives register and lazy-flag carries", () => {
  {
    const block = buildInstructionFunction((builder) => {
      builder.add(
        (s) => {
          s.loop((loop) => {
            loop.write(loop.reg("eax"), i32(0));
            return integer(1, 0);
          });
        },
        [],
        loc(repEip, repNextEip)
      );
    });

    planWasmFunction(lowerWasmFunction(block));
    assertCarries(loopIn(block), [gprChannel("eax")]);
  }

  {
    const block = buildInstructionFunction((builder) => {
      builder.add(
        (s) => {
          s.loop((loop) => {
            const zero = i32(0);

            loop.writeStatusFlagsSource(
              subFlagSource({
                left: zero,
                right: zero,
                result: zero
              })
            );
            return integer(1, 0);
          });
        },
        [],
        loc(repEip, repNextEip)
      );
    });

    planWasmFunction(lowerWasmFunction(block));
    assertCarries(loopIn(block), [
      flagStateFields.lazyKind,
      flagStateFields.lazyA,
      flagStateFields.lazyB
    ]);
  }
});

test("overlapping architectural writes are rejected during carry discovery", () => {
  throws(
    () =>
      buildInstructionFunction((builder) => {
        builder.add(
          (s) => {
            s.loop((loop) => {
              loop.write(loop.reg("al"), u8(1));
              loop.write(loop.reg("ax"), u16(2));
              return integer(1, 0);
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
      (s) => {
        const counter = s.var(i32(3));

        s.loop((loop) => {
          const next = loop.read(counter).sub(1);

          loop.write(counter, next);
          return next.ne(0);
        });
        s.write(s.reg("eax"), s.read(counter));
      },
      [],
      loc(repEip, repNextEip)
    );
  });
  const loop = loopIn(block);

  planWasmFunction(lowerWasmFunction(block));
  strictEqual(loop.carried.length, 0);

  const eaxWrites = block.entry.nodes.filter(
    (node): node is StateWriteOperation =>
      isStateWrite(node) && writesStateChannel(node, gprChannel("eax"))
  );

  strictEqual(eaxWrites.length, 1);
});
