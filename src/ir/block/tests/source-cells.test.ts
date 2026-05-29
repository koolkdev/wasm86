import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  mergeSourceCells,
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  sourceCellsOverlap
} from "#ir/block/source-cells.js";
import { registerAlias } from "#x86/registers.js";

test("SourceCell constructors preserve architectural register and flag identity", () => {
  deepStrictEqual(sourceCellForRegisterAlias(registerAlias("al")), {
    kind: "reg",
    reg: registerAlias("al")
  });
  deepStrictEqual(sourceCellForFlag("ZF"), { kind: "flag", flag: "ZF" });
});

test("sourceCellsOverlap uses register alias overlap and flag identity", () => {
  strictEqual(
    sourceCellsOverlap(
      sourceCellForRegisterAlias(registerAlias("al")),
      sourceCellForRegisterAlias(registerAlias("ax"))
    ),
    true
  );
  strictEqual(
    sourceCellsOverlap(
      sourceCellForRegisterAlias(registerAlias("al")),
      sourceCellForRegisterAlias(registerAlias("ah"))
    ),
    false
  );
  strictEqual(sourceCellsOverlap(sourceCellForFlag("CF"), sourceCellForFlag("CF")), true);
  strictEqual(sourceCellsOverlap(sourceCellForFlag("CF"), sourceCellForFlag("ZF")), false);
  strictEqual(
    sourceCellsOverlap(sourceCellForFlag("CF"), sourceCellForRegisterAlias(registerAlias("eax"))),
    false
  );
});

test("mixed register aliases merge structurally by base register", () => {
  deepStrictEqual(
    mergeSourceCells([
      sourceCellForRegisterAlias(registerAlias("al")),
      sourceCellForRegisterAlias(registerAlias("ah")),
      sourceCellForRegisterAlias(registerAlias("bl")),
      sourceCellForFlag("ZF"),
      sourceCellForFlag("ZF")
    ]),
    [
      { kind: "reg", reg: registerAlias("ax") },
      { kind: "reg", reg: registerAlias("bl") },
      { kind: "flag", flag: "ZF" }
    ]
  );

  deepStrictEqual(
    mergeSourceCells([
      sourceCellForRegisterAlias(registerAlias("al")),
      sourceCellForRegisterAlias(registerAlias("eax"))
    ]),
    [
      { kind: "reg", reg: registerAlias("eax") }
    ]
  );
});
