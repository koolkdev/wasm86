import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  exprBits,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject
} from "#ir/expr/builders.js";
import {
  RegisterState
} from "#ir/block/state/register-state.js";
import { RegisterMaterializer } from "#ir/block/state/register-materialization.js";
import { registerAlias } from "#x86/registers.js";

const exactAliasMaterializer = new RegisterMaterializer("exact-alias");
const fullBaseMaterializer = new RegisterMaterializer("full-base");

test("RegisterState reads aliases from the base register input", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(state.readAlias(registerAlias("eax")), eax);
  deepStrictEqual(state.readAlias(registerAlias("ax")), exprProject(16, eax));
  deepStrictEqual(state.readAlias(registerAlias("al")), exprProject(8, eax));
  deepStrictEqual(state.readAlias(registerAlias("ah")), exprBits(eax, 8, 8));
});

test("RegisterState writes AL while preserving AH and the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("al"), exprConst(0x12));
  const expectedEax = exprInsertBits(eax, exprConst(0x12), 0, 8);

  strictEqual(next === state, false);
  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("al")), exprConst(0x12));
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("ah")), exprBits(eax, 8, 8));
});

test("RegisterState writes AH while preserving AL and the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("ah"), exprConst(0x34));
  const expectedEax = exprInsertBits(eax, exprConst(0x34), 8, 8);

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("al")), exprProject(8, eax));
});

test("RegisterState writes AX while preserving the high word", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const next = state.writeAlias(registerAlias("ax"), exprConst(0x1234));
  const expectedEax = exprInsertBits(eax, exprConst(0x1234), 0, 16);

  deepStrictEqual(state.read("eax"), eax);
  deepStrictEqual(next.readAlias(registerAlias("eax")), expectedEax);
  deepStrictEqual(next.readAlias(registerAlias("ax")), exprConst(0x1234));
});

test("RegisterState detects alias no-op writes against the current alias value", () => {
  const state = RegisterState.initial();
  const narrowedEax = state.write(
    "eax",
    exprProject(16, exprInput({ kind: "reg", reg: "eax" }))
  );
  const same = narrowedEax.writeAlias(
    registerAlias("al"),
    narrowedEax.readAlias(registerAlias("al"))
  );

  strictEqual(same, narrowedEax);
});

test("RegisterState detects base register no-op writes", () => {
  const state = RegisterState.initial();
  const withOverlay = state.writeAlias(registerAlias("al"), exprConst(5));

  strictEqual(state.write("eax", exprInput({ kind: "reg", reg: "eax" })), state);
  strictEqual(withOverlay.write("eax", withOverlay.read("eax")), withOverlay);
  strictEqual(
    state.writeAlias(registerAlias("eax"), exprInput({ kind: "reg", reg: "eax" })),
    state
  );
});

test("RegisterState full EAX writes replace all aliases", () => {
  const state = RegisterState.initial();
  const withLowByte = state.writeAlias(registerAlias("al"), exprConst(0x7f));
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const replaced = withLowByte.write("eax", ebx);

  deepStrictEqual(
    withLowByte.read("eax"),
    exprInsertBits(exprInput({ kind: "reg", reg: "eax" }), exprConst(0x7f), 0, 8)
  );
  deepStrictEqual(replaced.readAlias(registerAlias("eax")), ebx);
  deepStrictEqual(replaced.readAlias(registerAlias("ax")), exprProject(16, ebx));
  deepStrictEqual(replaced.readAlias(registerAlias("al")), exprProject(8, ebx));
  deepStrictEqual(replaced.readAlias(registerAlias("ah")), exprBits(ebx, 8, 8));
});

test("RegisterState canonicalizes values at write boundaries", () => {
  const state = RegisterState.initial();
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const changed = state.write("eax", exprProject(32, ebx));

  deepStrictEqual(changed.read("eax"), ebx);
});

test("RegisterState reads aliases directly from overlays without simplification", () => {
  const state = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const lowByte = state.writeAlias(registerAlias("al"), exprConst(5));
  const replacedBase = state
    .write("eax", exprInput({ kind: "reg", reg: "ebx" }))
    .writeAlias(registerAlias("al"), exprConst(5));

  deepStrictEqual(lowByte.readAlias(registerAlias("al")), exprConst(5));
  deepStrictEqual(lowByte.readAlias(registerAlias("ah")), exprBits(eax, 8, 8));
  deepStrictEqual(
    lowByte.readAlias(registerAlias("ax")),
    exprInsertBits(exprProject(16, eax), exprConst(5), 0, 8)
  );
  deepStrictEqual(
    replacedBase.readAlias(registerAlias("eax")),
    exprInsertBits(exprInput({ kind: "reg", reg: "ebx" }), exprConst(5), 0, 8)
  );
});

test("RegisterState normalizes fully shadowed alias overlays", () => {
  const state = RegisterState.initial()
    .writeAlias(registerAlias("ax"), exprConst(0x1234))
    .writeAlias(registerAlias("al"), exprConst(0x56))
    .writeAlias(registerAlias("ah"), exprConst(0x78));

  deepStrictEqual(state.readAlias(registerAlias("ax")), exprConst(0x7856));
  deepStrictEqual(
    exactAliasMaterializer.writes(RegisterState.initial(), state),
    [
      { reg: registerAlias("al"), value: exprConst(0x56) },
      { reg: registerAlias("ah"), value: exprConst(0x78) }
    ]
  );
});

test("RegisterMaterializer compares baseline and snapshot states", () => {
  const baseline = RegisterState.initial();
  const eax = exprInput({ kind: "reg", reg: "eax" });
  const ebx = exprInput({ kind: "reg", reg: "ebx" });

  deepStrictEqual(
    exactAliasMaterializer.writes(baseline, RegisterState.initial()),
    []
  );
  deepStrictEqual(
    exactAliasMaterializer.writes(
      baseline,
      baseline.writeAlias(registerAlias("al"), exprConst(5))
    ),
    [{ reg: registerAlias("al"), value: exprConst(5) }]
  );
  deepStrictEqual(
    exactAliasMaterializer.writes(
      baseline,
      baseline.write("eax", ebx).writeAlias(registerAlias("al"), exprConst(5))
    ),
    [
      { reg: registerAlias("eax"), value: ebx },
      { reg: registerAlias("al"), value: exprConst(5) }
    ]
  );
  deepStrictEqual(
    exactAliasMaterializer.writes(
      baseline.writeAlias(registerAlias("al"), exprConst(5)),
      baseline
    ),
    [{ reg: registerAlias("al"), value: exprProject(8, eax) }]
  );
});

test("RegisterMaterializer exact-alias mode preserves partial write behavior", () => {
  const baseline = RegisterState.initial();
  const snapshot = baseline.writeAlias(registerAlias("al"), exprConst(5));

  deepStrictEqual(
    exactAliasMaterializer.writes(baseline, snapshot),
    [{ reg: registerAlias("al"), value: exprConst(5) }]
  );
});

test("RegisterMaterializer full-base mode emits full base for partial writes", () => {
  const baseline = RegisterState.initial();
  const snapshot = baseline.writeAlias(registerAlias("al"), exprConst(5));

  deepStrictEqual(
    fullBaseMaterializer.writes(baseline, snapshot),
    [{ reg: registerAlias("eax"), value: snapshot.read("eax") }]
  );
});

test("RegisterMaterializer full-base mode emits no write when the full base is unchanged", () => {
  const baseline = RegisterState.initial().writeAlias(registerAlias("al"), exprConst(5));
  const snapshot = RegisterState.initial().write("eax", baseline.read("eax"));

  deepStrictEqual(
    fullBaseMaterializer.writes(baseline, snapshot),
    []
  );
});

test("RegisterMaterializer full-base mode emits one write per changed base", () => {
  const baseline = RegisterState.initial();
  const ebx = exprInput({ kind: "reg", reg: "ebx" });
  const snapshot = baseline
    .write("eax", ebx)
    .writeAlias(registerAlias("al"), exprConst(5));

  deepStrictEqual(
    fullBaseMaterializer.writes(baseline, snapshot),
    [{ reg: registerAlias("eax"), value: snapshot.read("eax") }]
  );
});

test("RegisterMaterializer narrows baseline overlay resets to uncovered aliases", () => {
  const baseline = RegisterState.initial().writeAlias(
    registerAlias("ax"),
    exprInput({ kind: "reg", reg: "ebx" })
  );
  const snapshot = RegisterState.initial().writeAlias(registerAlias("al"), exprConst(5));
  const eax = exprInput({ kind: "reg", reg: "eax" });

  deepStrictEqual(
    exactAliasMaterializer.writes(baseline, snapshot),
    [
      { reg: registerAlias("ah"), value: exprBits(eax, 8, 8) },
      { reg: registerAlias("al"), value: exprConst(5) }
    ]
  );
});
