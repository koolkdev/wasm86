import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { CellRef } from "#compiler/refs/cell.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type {
  DecodeCandidate,
  InstructionForm,
  ModRmFieldSelection,
  ModRmModeForms,
  OpcodeLeaf,
  OpcodeNode
} from "#core/decoder/model/types.js";
import { invalidOpcode } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import type { InstructionSpec } from "#core/isa/spec.js";
import type { OperandBinding } from "#core/instruction/bindings.js";
import type { BuildExit } from "#core/instruction/terminal.js";
import type { StateAccess } from "#core/state/access.js";
import type { RegionBuilder, SwitchControlArm } from "#ir/region-builder.js";
import type { MemoryAccessConstruction } from "#memory/access.js";
import { ModRmAddressDecoder } from "./decode/address.js";
import {
  memoryFormDispatch,
  exactModRmCases,
  modRmRegCases
} from "./decode/forms.js";
import {
  OperandDecoder,
  type DecodedRm
} from "./decode/operands.js";
import { PrefixDecoder } from "./decode/prefixes.js";
import { InstructionByteStream } from "./decode/stream.js";

type SelectedDecodeCandidate = Exclude<
  DecodeCandidate,
  Readonly<{ kind: "empty" }>
>;

export type DecodedInstruction = Readonly<{
  instruction: InstructionSpec;
  instructionStart: ValueId;
  nextEip: ValueId;
  bindings: readonly OperandBinding[];
}>;

export type BuildDecodedInstruction = (
  region: RegionBuilder,
  instruction: DecodedInstruction
) => void;

export type InterpreterDecodeOptions = Readonly<{
  stateAccess: StateAccess;
  memory: MemoryAccessConstruction;
  buildExit: BuildExit;
  buildInstruction: BuildDecodedInstruction;
}>;

// Emits decode and instruction construction into the enclosing function;
// decode/* classes organize author-time construction, not generated calls.
export function buildDecodeAndDispatch(
  region: RegionBuilder,
  instructionStart: ValueId,
  options: InterpreterDecodeOptions
): void {
  new InterpreterDecoder(region, instructionStart, options).build();
}

class InterpreterDecoder {
  readonly #root: RegionBuilder;
  readonly #instructionStart: ValueId;
  readonly #options: InterpreterDecodeOptions;
  readonly #stream: InstructionByteStream;
  readonly #prefixes: PrefixDecoder;
  readonly #memoryFormOrdinal: CellRef;
  readonly #modRmByte: CellRef;
  readonly #address: ModRmAddressDecoder;
  readonly #operands: OperandDecoder;

  constructor(
    region: RegionBuilder,
    instructionStart: ValueId,
    options: InterpreterDecodeOptions
  ) {
    const invalidFormOrdinal = region.values.const(-1);

    this.#root = region;
    this.#instructionStart = instructionStart;
    this.#options = options;
    this.#stream = new InstructionByteStream(
      region,
      instructionStart,
      options.memory,
      options.buildExit
    );
    this.#prefixes = new PrefixDecoder(region, this.#stream);
    this.#memoryFormOrdinal = region.cell(invalidFormOrdinal);
    this.#modRmByte = region.cell(region.values.const(0x100));
    this.#operands = new OperandDecoder({
      instructionStart,
      stream: this.#stream,
      segmentOverride: this.#prefixes.segmentOverride,
      modRmByte: this.#modRmByte
    });
    this.#address = new ModRmAddressDecoder(region, {
      stream: this.#stream,
      stateAccess: options.stateAccess,
      segmentOverride: this.#prefixes.segmentOverride,
      unreachable: (unreachable) => this.#unreachable(unreachable)
    });
  }

  build(): void {
    const root = this.#root;

    this.#prefixes.decode(root);
    this.#dispatchOpcode(
      root,
      X86_32_DECODE_MODEL.opcodeRoot,
      this.#prefixes.firstOpcodeByte(root)
    );

    // Plain and register forms terminate inside opcode dispatch. Memory forms
    // alone fall through with a selected form and share this address decoder.
    this.#address.decode(root, root.read(this.#modRmByte));
    this.#dispatchSelectedMemoryForm(root);
  }

  #dispatchOpcode(
    region: RegionBuilder,
    node: OpcodeNode,
    byte: ValueId
  ): void {
    const arms: SwitchControlArm[] = [];

    node.next.forEach((next, match) => {
      if (next === undefined) {
        return;
      }
      arms.push({
        matches: [match],
        build: (opcode) => {
          if (next.leaf !== undefined) {
            this.#dispatchOpcodeLeaf(opcode, next.leaf);
            return;
          }
          this.#dispatchOpcode(
            opcode,
            next,
            this.#stream.readByte(opcode)
          );
        }
      });
    });
    region.switchControl(byte, arms, (invalid) => this.#invalidOpcode(invalid));
  }

  #dispatchOpcodeLeaf(region: RegionBuilder, leaf: OpcodeLeaf): void {
    const flags = region.values.binary(
      "and",
      this.#prefixes.flags(region),
      region.values.const(X86_32_DECODE_MODEL.prefixes.flagMask)
    );
    const arms: SwitchControlArm[] = [];

    leaf.byPrefix.forEach((candidate, match) => {
      if (candidate.kind !== "empty") {
        arms.push({
          matches: [match],
          build: (selected) => this.#dispatchCandidate(selected, candidate)
        });
      }
    });
    region.switchControl(flags, arms, (invalid) => this.#invalidOpcode(invalid));
  }

  #dispatchCandidate(
    region: RegionBuilder,
    candidate: SelectedDecodeCandidate
  ): void {
    switch (candidate.kind) {
      case "plain":
        assert(
          candidate.form.modrm === undefined,
          `${candidate.form.id} unexpectedly reads ModRM`
        );
        this.#buildInstruction(region, candidate.form, { kind: "none" });
        return;
      case "modRm": {
        this.#dispatchModRm(region, candidate);
        return;
      }
    }
  }

  #dispatchModRm(
    region: RegionBuilder,
    candidate: Extract<DecodeCandidate, { kind: "modRm" }>
  ): void {
    const byte = this.#stream.readByte(region);
    const selection = candidate.formSelection;

    switch (selection.kind) {
      case "exact":
        this.#dispatchExactModRm(region, byte, selection.byByte);
        return;
      case "fields":
        this.#dispatchModRmFields(region, byte, selection.fields);
        return;
    }
  }

  #dispatchExactModRm(
    region: RegionBuilder,
    byte: ValueId,
    byByte: readonly (InstructionForm | undefined)[]
  ): void {
    // The exact byte selects both the form and its register or memory path.
    region.switchControl(
      byte,
      exactModRmCases(byByte).map(({ matches, form, mode }) => ({
        matches,
        build: (selected) => {
          selected.write(this.#modRmByte, byte);
          this.#buildModRmForm(selected, byte, form, mode);
        }
      })),
      (invalid) => this.#invalidOpcode(invalid)
    );
  }

  #dispatchModRmFields(
    region: RegionBuilder,
    byte: ValueId,
    fields: ModRmFieldSelection
  ): void {
    switch (fields.kind) {
      case "mode":
        this.#dispatchModRmMode(region, byte, fields.forms);
        return;
      case "reg":
        this.#dispatchModRmReg(region, byte, fields.byReg);
        return;
    }
  }

  #dispatchModRmMode(
    region: RegionBuilder,
    byte: ValueId,
    forms: ModRmModeForms
  ): void {
    // The forms are already selected; only register versus memory remains.
    this.#dispatchModRmForms(
      region,
      byte,
      this.#registerMode(region, byte),
      forms
    );
  }

  #dispatchModRmReg(
    region: RegionBuilder,
    byte: ValueId,
    byReg: readonly ModRmModeForms[]
  ): void {
    // Select the opcode-group forms by ModRM.reg, then branch between their
    // register and memory forms inside the selected arm.
    const formSelector = region.values.binary(
      "and",
      region.values.binary(
        "shr_u",
        byte,
        region.values.const(3)
      ),
      region.values.const(0b111)
    );
    const registerMode = this.#registerMode(region, byte);

    region.switchControl(
      formSelector,
      modRmRegCases(byReg).map(({ matches, forms }) => ({
        matches,
        build: (selected) => this.#dispatchModRmForms(
          selected,
          byte,
          registerMode,
          forms
        )
      })),
      (invalid) => this.#invalidOpcode(invalid)
    );
  }

  #registerMode(region: RegionBuilder, byte: ValueId): ValueId {
    return region.values.compare(
      32,
      "ge_u",
      byte,
      region.values.const(0xc0)
    );
  }

  #dispatchModRmForms(
    region: RegionBuilder,
    byte: ValueId,
    registerMode: ValueId,
    forms: ModRmModeForms
  ): void {
    region.write(this.#modRmByte, byte);
    region.if(
      registerMode,
      (register) => this.#buildModRmForm(
        register,
        byte,
        forms.register,
        "register"
      ),
      {
        elseBuild: (memory) => this.#buildModRmForm(
          memory,
          byte,
          forms.memory,
          "memory"
        )
      }
    );
  }

  #buildModRmForm(
    region: RegionBuilder,
    byte: ValueId,
    form: InstructionForm | undefined,
    mode: "register" | "memory"
  ): void {
    if (form === undefined) {
      this.#invalidOpcode(region);
      return;
    }
    switch (mode) {
      case "register":
        // Register arms have all required decode information and finish here.
        this.#buildInstruction(region, form, {
          kind: "register",
          registerIndex: region.values.binary(
            "and",
            byte,
            region.values.const(0b111)
          )
        });
        return;
      case "memory":
        // Memory arms record the selected form and join after opcode dispatch;
        // build() then decodes the address once and builds that instruction.
        this.#recordMemoryForm(region, form);
        return;
    }
  }

  #recordMemoryForm(region: RegionBuilder, form: InstructionForm): void {
    const ordinal = memoryFormDispatch.ordinalByForm.get(form);

    assert(
      ordinal !== undefined,
      `decode model omitted memory form ${form.id}`
    );
    region.write(this.#memoryFormOrdinal, region.values.const(ordinal));
  }

  #dispatchSelectedMemoryForm(region: RegionBuilder): void {
    const ordinal = region.read(this.#memoryFormOrdinal);

    // Compiler switch matches are bounded, so dispatch one switch-sized group
    // at a time. The default arm carries larger ordinals into the next group,
    // leaving forms in the first group on this switch alone.
    this.#dispatchMemoryFormGroups(
      region,
      ordinal,
      memoryFormDispatch.groups
    );
  }

  #dispatchMemoryFormGroups(
    region: RegionBuilder,
    ordinal: ValueId,
    groups: readonly (readonly InstructionForm[])[]
  ): void {
    assert(groups.length !== 0, "memory form dispatch has no groups");
    const forms = groups[0];
    const remainingGroups = groups.slice(1);

    assert(forms !== undefined, "memory form dispatch group is missing");
    region.switchControl(
      ordinal,
      forms.map((form, slot) => ({
        matches: [slot],
        build: (formArm) => this.#buildMemoryInstruction(formArm, form)
      })),
      remainingGroups.length === 0
        ? (unreachable) => this.#unreachable(unreachable)
        : (nextGroup) => {
          const nextOrdinal = nextGroup.values.binary(
            "sub",
            ordinal,
            nextGroup.values.const(memoryFormDispatch.groupSize)
          );

          this.#dispatchMemoryFormGroups(
            nextGroup,
            nextOrdinal,
            remainingGroups
          );
        }
    );
  }

  #buildMemoryInstruction(
    region: RegionBuilder,
    form: InstructionForm
  ): void {
    this.#address.withAddress(
      region,
      (addressArm, address) =>
        this.#buildInstruction(addressArm, form, address)
    );
  }

  #buildInstruction(
    region: RegionBuilder,
    form: InstructionForm,
    rm: DecodedRm
  ): void {
    const bindings = this.#operands.buildBindings(region, form, rm);
    const nextEip = region.values.binary(
      "add",
      this.#instructionStart,
      this.#stream.offset(region)
    );

    this.#options.buildInstruction(region, {
      instruction: form.instruction,
      instructionStart: this.#instructionStart,
      nextEip,
      bindings
    });
  }

  #invalidOpcode(region: RegionBuilder): void {
    region.return([
      this.#options.buildExit(
        region.values,
        exceptionExit(invalidOpcode())
      )
    ]);
  }

  #unreachable(region: RegionBuilder): void {
    region.return([region.values.unreachable("i64")]);
  }
}
