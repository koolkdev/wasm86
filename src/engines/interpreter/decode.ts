import { assert } from "#common/assert.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { CellRef } from "#compiler/refs/cell.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type {
  DecodeCandidate,
  InstructionForm,
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
  modRmCandidateCases
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
  readonly #memoryFormPage: CellRef;
  readonly #memoryFormIndex: CellRef;
  readonly #modRmByte: CellRef;
  readonly #address: ModRmAddressDecoder;
  readonly #operands: OperandDecoder;

  constructor(
    region: RegionBuilder,
    instructionStart: ValueId,
    options: InterpreterDecodeOptions
  ) {
    const invalidSelection = region.values.const(-1);

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
    this.#memoryFormPage = region.cell(invalidSelection);
    this.#memoryFormIndex = region.cell(invalidSelection);
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
        const byte = this.#stream.readByte(region);
        const arms: SwitchControlArm[] = [];

        for (const candidateCase of modRmCandidateCases(candidate)) {
          if (candidateCase.registerMatches.length > 0) {
            arms.push({
              matches: candidateCase.registerMatches,
              build: (register) => {
                register.write(this.#modRmByte, byte);
                this.#buildInstruction(register, candidateCase.form, {
                  kind: "register",
                  registerIndex: register.values.binary(
                    "and",
                    byte,
                    register.values.const(0b111)
                  )
                });
              }
            });
          }
          if (candidateCase.memoryMatches.length > 0) {
            arms.push({
              matches: candidateCase.memoryMatches,
              build: (memory) => {
                memory.write(this.#modRmByte, byte);
                this.#selectMemoryForm(memory, candidateCase.form);
              }
            });
          }
        }
        region.switchControl(
          byte,
          arms,
          (invalid) => this.#invalidOpcode(invalid)
        );
        return;
      }
    }
  }

  #selectMemoryForm(region: RegionBuilder, form: InstructionForm): void {
    const location = memoryFormDispatch.locations.get(form.id);

    assert(
      location !== undefined,
      `decode model omitted memory form ${form.id}`
    );
    region.write(this.#memoryFormPage, region.values.const(location.page));
    region.write(this.#memoryFormIndex, region.values.const(location.index));
  }

  #dispatchSelectedMemoryForm(region: RegionBuilder): void {
    region.switchControl(
      region.read(this.#memoryFormPage),
      memoryFormDispatch.pages.map((forms, page) => ({
        matches: [page],
        build: (pageArm) => pageArm.switchControl(
          pageArm.read(this.#memoryFormIndex),
          forms.map((form, index) => ({
            matches: [index],
            build: (formArm) => this.#buildMemoryInstruction(formArm, form)
          })),
          (unreachable) => this.#unreachable(unreachable)
        )
      })),
      (unreachable) => this.#unreachable(unreachable)
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
