import {
  deepStrictEqual,
  strictEqual,
  throws,
  test,
  c32,
  exitPoint,
  exitState,
  ExitReason,
  jitInputAluFlagsValue,
  jitInputReg16Value,
  jitInputReg32Value,
  jitLoadResultValue,
  plannedStoreSources,
  registerStore,
  flagStore,
  rootPath,
  type ExitStore,
  type JitValue,
  type PlannedExit
} from "./plan-test-helpers.js";
import { jitExtractMaskedBits } from "#backends/wasm/jit/ir/values/builders.js";
import type {
  Capture,
  CapturePlan
} from "#backends/wasm/jit/codegen/plan/captures.js";
import {
  planStoreStrategy,
  sourceNeedsCapture,
  storeClobberSourceStores,
  storeClobberValues
} from "#backends/wasm/jit/codegen/plan/store-strategy.js";
import type { ValueUse } from "#backends/wasm/jit/codegen/plan/value-uses.js";

test("JIT store strategy keeps independent stores inline and preserves order", () => {
  const stores = [
    registerStore("eax", c32(1)),
    registerStore("ebx", jitInputReg32Value("ecx"))
  ];
  const exit = testExit(stores);
  const strategy = planStoreStrategy({
    exits: [exit],
    captures: capturePlan([])
  });

  deepStrictEqual(strategy.exitStoreSets[exit.exitStoreIndex], {
    stores: [
      { store: stores[0], source: { kind: "inline" } },
      { store: stores[1], source: { kind: "inline" } }
    ]
  });
  deepStrictEqual(plannedStoreSources(strategy.exits[0]!.stores), [
    [stores[0], "inline"],
    [stores[1], "inline"]
  ]);
});

test("JIT store strategy captures later register-swap sources clobbered by earlier stores", () => {
  const firstStore = registerStore("eax", jitInputReg32Value("ebx"));
  const clobberedStore = registerStore("ebx", jitInputReg32Value("eax"));
  const exit = testExit([firstStore, clobberedStore]);
  const capture = storeClobberCapture(exit, clobberedStore.value);
  const strategy = planStoreStrategy({
    exits: [exit],
    captures: capturePlan([capture])
  });
  const planned = strategy.exits[0]!.stores;

  deepStrictEqual(plannedStoreSources(planned), [
    [firstStore, "inline"],
    [clobberedStore, "capture"]
  ]);
  strictEqual(planned[1]!.source.kind, "capture");
  if (planned[1]!.source.kind === "capture") {
    strictEqual(planned[1]!.source.capture, capture);
    strictEqual(planned[1]!.source.capture.reason, "storeClobber");
  }
});

test("JIT store strategy captures register rotation sources that read earlier targets", () => {
  const stores = [
    registerStore("eax", jitInputReg32Value("ebx")),
    registerStore("ebx", jitInputReg32Value("ecx")),
    registerStore("ecx", jitInputReg32Value("eax"))
  ];
  const exit = testExit(stores);
  const strategy = planStoreStrategy({
    exits: [exit],
    captures: capturePlan([
      storeClobberCapture(exit, stores[2]!.value)
    ])
  });

  deepStrictEqual(plannedStoreSources(strategy.exits[0]!.stores), [
    [stores[0], "inline"],
    [stores[1], "inline"],
    [stores[2], "capture"]
  ]);
});

test("JIT store strategy handles register aliases and flag clobbers", () => {
  const overwriteAh = {
    target: { kind: "reg8", reg: "ah" },
    value: c32(0)
  } as const satisfies ExitStore;
  const wordStore = registerStore("ebx", jitInputReg16Value("ax"));
  const flagOverwrite = flagStore(c32(0));
  const flagSource = registerStore("eax", jitInputAluFlagsValue());
  const registerExit = testExit([overwriteAh, wordStore], 1);
  const flagExit = testExit([flagOverwrite, flagSource], 2);

  strictEqual(sourceNeedsCapture(wordStore, [overwriteAh.target]), true);
  strictEqual(sourceNeedsCapture(flagSource, [flagOverwrite.target]), true);
  deepStrictEqual(storeClobberSourceStores(registerExit), [wordStore]);
  deepStrictEqual(planStoreStrategy({
    exits: [registerExit, flagExit],
    captures: capturePlan([
      storeClobberCapture(registerExit, wordStore.value),
      storeClobberCapture(flagExit, flagSource.value)
    ])
  }).exits.map((entry) => plannedStoreSources(entry.stores)), [
    [
      [overwriteAh, "inline"],
      [wordStore, "capture"]
    ],
    [
      [flagOverwrite, "inline"],
      [flagSource, "capture"]
    ]
  ]);
});

test("JIT store strategy ignores non-overlapping alias source dependencies", () => {
  const overwriteAh = {
    target: { kind: "reg8", reg: "ah" },
    value: c32(0)
  } as const satisfies ExitStore;
  const lowByteSource = registerStore(
    "ebx",
    jitExtractMaskedBits(jitInputReg32Value("eax"), 0xff)
  );

  strictEqual(sourceNeedsCapture(lowByteSource, [overwriteAh.target]), false);
  deepStrictEqual(storeClobberSourceStores(testExit([overwriteAh, lowByteSource])), []);
});

test("JIT store strategy ignores target slots, constants, and load-result values as source hazards", () => {
  const loadResult = jitLoadResultValue(0, "i32");
  const stores = [
    registerStore("eax", c32(1)),
    registerStore("ebx", c32(2)),
    registerStore("ecx", loadResult)
  ];
  const exit = testExit(stores);

  deepStrictEqual(storeClobberSourceStores(exit), []);
  deepStrictEqual(storeClobberValues([exit]), []);
});

test("JIT store strategy fails when a clobbered source has no store-clobber capture", () => {
  const stores = [
    registerStore("eax", c32(0)),
    registerStore("ebx", jitInputReg32Value("eax"))
  ];

  throws(
    () => planStoreStrategy({
      exits: [testExit(stores)],
      captures: capturePlan([])
    }),
    /missing JIT store-clobber capture/
  );
});

function testExit(
  stores: readonly ExitStore[],
  exitStoreIndex = 1
): PlannedExit {
  return exitPoint({ opIndex: exitStoreIndex,
    reason: ExitReason.HOST_TRAP,
    snapshot: exitState(0),
    stores,
    exitStoreIndex,
    path: rootPath()
  });
}

function storeClobberCapture(exit: PlannedExit, value: JitValue): Capture {
  const consumer: ValueUse = {
    value,
    at: { opIndex: exit.at.opIndex,
      epoch: 0
    },
    path: exit.path,
    purpose: "exitStore",
    root: value,
    ancestors: [],
    exitId: exit.id
  };

  return {
    value,
    at: consumer.at,
    availability: exit.path,
    consumers: [consumer],
    reason: "storeClobber"
  };
}

function capturePlan(captures: readonly Capture[]): CapturePlan {
  return {
    captures,
    runtimeCaptures: new Map()
  };
}
