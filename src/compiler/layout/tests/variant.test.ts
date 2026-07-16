import {
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  decodeVariant,
  encodeVariant
} from "#compiler/layout/variant-codec.js";
import {
  VariantFieldRef,
  VariantRef,
  createVariantLayout,
  variantSet
} from "#compiler/layout/variant.js";

function exampleDefinition(reverseVariants = false) {
  const byte = new VariantFieldRef("example.variant.mixed.byte", "u8");
  const word = new VariantFieldRef("example.variant.mixed.word", "u16");
  const mixed = new VariantRef("example.variant.mixed", [byte, word]);
  const empty = new VariantRef("example.variant.empty", []);
  const variants = reverseVariants ? [mixed, empty] : [empty, mixed];

  return {
    byte,
    word,
    mixed,
    empty,
    set: variantSet("example.variant", variants)
  };
}

test("independently declared equal variant definitions resolve equally", () => {
  const first = exampleDefinition();
  const second = exampleDefinition();

  deepStrictEqual(
    createVariantLayout("test.variant", [first.set]).record,
    createVariantLayout("test.variant", [second.set]).record
  );
});

test("set and variant declaration order do not assign wire identity", () => {
  const first = exampleDefinition();
  const second = exampleDefinition(true);
  const extraFirst = new VariantRef("extra.variant.first", []);
  const extraSecond = new VariantRef("extra.variant.second", []);
  const extra = variantSet("extra.variant", [extraSecond, extraFirst]);

  deepStrictEqual(
    createVariantLayout("test.variant", [first.set, extra]).record,
    createVariantLayout("test.variant", [
      variantSet("extra.variant", [extraFirst, extraSecond]),
      second.set
    ]).record
  );
});

test("field width, explicit field sequence, and added variants change the envelope", () => {
  const originalByte = new VariantFieldRef("shape.variant.value.byte", "u8");
  const originalWord = new VariantFieldRef("shape.variant.value.word", "u16");
  const original = variantSet("shape.variant", [
    new VariantRef("shape.variant.value", [originalByte, originalWord])
  ]);
  const reorderedByte = new VariantFieldRef("shape.variant.value.byte", "u8");
  const reorderedWord = new VariantFieldRef("shape.variant.value.word", "u16");
  const reordered = variantSet("shape.variant", [
    new VariantRef("shape.variant.value", [reorderedWord, reorderedByte])
  ]);
  const widenedByte = new VariantFieldRef("shape.variant.value.byte", "u16");
  const widenedWord = new VariantFieldRef("shape.variant.value.word", "u16");
  const widened = variantSet("shape.variant", [
    new VariantRef("shape.variant.value", [widenedByte, widenedWord])
  ]);
  const additionalByte = new VariantFieldRef("shape.variant.value.byte", "u8");
  const additionalWord = new VariantFieldRef("shape.variant.value.word", "u16");
  const additional = variantSet("shape.variant", [
    new VariantRef("shape.variant.value", [additionalByte, additionalWord]),
    new VariantRef("shape.variant.other", [])
  ]);
  const originalRecord = createVariantLayout("test.variant", [original]).record;

  notDeepStrictEqual(originalRecord, createVariantLayout("test.variant", [reordered]).record);
  notDeepStrictEqual(originalRecord, createVariantLayout("test.variant", [widened]).record);
  notDeepStrictEqual(originalRecord, createVariantLayout("test.variant", [additional]).record);
});

test("resolution assigns nonzero tags and naturally aligned overlaid payloads", () => {
  const definition = exampleDefinition();
  const layout = createVariantLayout("test.variant", [definition.set]);

  strictEqual(layout.variant(definition.empty).tag > 0, true);
  strictEqual(layout.variant(definition.mixed).tag > 0, true);
  notDeepStrictEqual(
    layout.variant(definition.empty).tag,
    layout.variant(definition.mixed).tag
  );
  deepStrictEqual(layout.field(definition.byte), { offset: 0, byteLength: 1 });
  deepStrictEqual(layout.field(definition.word), { offset: 2, byteLength: 2 });
  strictEqual(layout.variant(definition.mixed).payloadByteLength, 4);
  strictEqual(layout.tagOffset, 4);
  strictEqual(layout.byteLength, 5);
});

test("the derived host codec round-trips fieldless and mixed payload variants", () => {
  const address = new VariantFieldRef("codec.variant.fault.address", "u32");
  const detail = new VariantFieldRef("codec.variant.fault.detail", "u16");
  const fieldless = new VariantRef("codec.variant.fieldless", []);
  const fault = new VariantRef("codec.variant.fault", [address, detail]);
  const layout = createVariantLayout("codec.variant", [
    variantSet("codec.variant", [fault, fieldless])
  ]);
  const emptyEncoded = encodeVariant(layout, {
    variant: fieldless,
    payload: []
  });
  const faultEncoded = encodeVariant(layout, {
    variant: fault,
    payload: [
      { field: detail, value: 0x8001 },
      { field: address, value: 0xffff_fffc }
    ]
  });
  const emptyDecoded = decodeVariant(layout, emptyEncoded);
  const faultDecoded = decodeVariant(layout, faultEncoded);

  strictEqual(emptyDecoded.variant, fieldless);
  strictEqual(faultDecoded.variant, fault);
  strictEqual(faultDecoded.value(address), 0xffff_fffc);
  strictEqual(faultDecoded.value(detail), 0x8001);
  throws(() => emptyDecoded.value(address), /does not belong to decoded variant/);
});

test("the derived codec rejects unknown tags, unused bits, and malformed payloads", () => {
  const definition = exampleDefinition();
  const layout = createVariantLayout("test.variant", [definition.set]);

  throws(() => decodeVariant(layout, 0n), /unknown test.variant variant tag: 0/);

  const empty = encodeVariant(layout, {
    variant: definition.empty,
    payload: []
  });
  throws(
    () => decodeVariant(layout, empty | (1n << 8n)),
    /nonzero unused payload bits/
  );
  throws(
    () => encodeVariant(layout, {
      variant: definition.mixed,
      payload: [{ field: definition.byte, value: 1 }]
    }),
    /expected 2/
  );
  throws(
    () => encodeVariant(layout, {
      variant: definition.mixed,
      payload: [
        { field: definition.byte, value: 1 },
        { field: definition.byte, value: 2 }
      ]
    }),
    /duplicate payload field/
  );
  throws(
    () => encodeVariant(layout, {
      variant: definition.mixed,
      payload: [
        { field: definition.byte, value: 0x100 },
        { field: definition.word, value: 0 }
      ]
    }),
    /does not fit u8/
  );
  throws(
    () => encodeVariant(layout, {
      variant: definition.mixed,
      payload: [
        { field: new VariantFieldRef("example.variant.mixed.byte", "u8"), value: 1 },
        { field: definition.word, value: 0 }
      ]
    }),
    /does not belong to variant/
  );
});

test("duplicate identities, foreign handles, malformed definitions, and i64 overflow reject", () => {
  const duplicateFirst = new VariantRef("duplicate.variant.same", []);
  const duplicateSecond = new VariantRef("duplicate.variant.same", []);

  throws(
    () => createVariantLayout("test.variant", [
      variantSet("duplicate.variant", [duplicateFirst, duplicateSecond])
    ]),
    /duplicate variant id/
  );
  throws(
    () => createVariantLayout("test.variant", [variantSet("empty.variant", [])]),
    /has no variants/
  );
  throws(
    () => createVariantLayout("bad id", [
      variantSet("valid.variant", [new VariantRef("valid.variant.value", [])])
    ]),
    /must be a stable id/
  );

  const definition = exampleDefinition();
  const layout = createVariantLayout("test.variant", [definition.set]);
  const equalButForeign = exampleDefinition();

  throws(() => layout.variant(equalButForeign.empty), /does not belong/);
  throws(() => layout.field(equalButForeign.byte), /does not belong/);

  const first = new VariantFieldRef("wide.variant.value.first", "u32");
  const second = new VariantFieldRef("wide.variant.value.second", "u32");

  throws(
    () => createVariantLayout("wide.variant", [
      variantSet("wide.variant", [
        new VariantRef("wide.variant.value", [first, second])
      ])
    ]),
    /does not fit an i64/
  );
});
