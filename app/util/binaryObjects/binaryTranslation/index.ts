// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2020-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { sumBy, maxBy } from "lodash";

// @ts-expect-error
import ModuleFactory from "./bin/translator";
// @ts-expect-error
import ModuleWasm from "./bin/translator.wasm";
import { Message } from "@foxglove-studio/app/players/types";
import { RosDatatype, RosDatatypes } from "@foxglove-studio/app/types/RosDatatypes";

// TODO: move this to a utils file?
function isNodeModule() {
  return typeof process === "undefined" || !("browser" in process);
}

// TODO: move this to a utils file?
async function getModuleFactory(): Promise<unknown> {
  // When running outside a browser (i.e. tests), we can let Emscripten to
  // resolve the WASM file automatically. That does fail when running in the browser because
  // of Webpack, so we need to indicate the Wasm location manually
  if (isNodeModule()) {
    return ModuleFactory();
  }
  return ModuleFactory({
    locateFile: () => {
      // get the path to the wasm file
      // Webpack puts this file in the `dist` directory
      return ModuleWasm;
    },
  });
}

export interface BinaryDefinition {
  getSize(): number;
}

export type BinaryObjects = Readonly<{
  dataType: string;
  offsets: readonly number[];
  buffer: ArrayBuffer;
  bigString: string;
}>;

export const DefinitionCommand = {
  READ_FIXED_SIZE_DATA: 0,
  READ_STRING: 1,
  READ_DYNAMIC_SIZE_DATA: 2,
  CONSTANT_ARRAY: 3,
  DYNAMIC_ARRAY: 4,
};

export default class BinaryMessageWriter {
  _bridgeInstance: any = null;
  _definitionRegistry: any = null;

  async initialize() {
    this._bridgeInstance = await getModuleFactory();
    if (this._bridgeInstance) {
      this._definitionRegistry = new this._bridgeInstance.DefinitionRegistry();
    }
  }

  _getBridge(): any {
    if (!this._bridgeInstance) {
      throw new Error("Wasm bridge not initialized");
    }
    return this._bridgeInstance;
  }

  _getDefinitions(): any {
    if (!this._definitionRegistry) {
      throw new Error("Definition registry not initialized");
    }
    return this._definitionRegistry;
  }

  // Creates a definition and adds it to the registry
  // Does not validate the definition. It must be done later.
  _createDefinition(name: string, dataType: RosDatatype): BinaryDefinition {
    const definition = this._getDefinitions().create(name);
    for (const field of dataType.fields) {
      if (field.isConstant) {
        // ignore constant fields since they have no values in the message's data.
        continue;
      }
      if (!definition.addField(field.type, field.name, field.isArray, field.arrayLength ?? -1)) {
        throw new Error(`Could not add field with type "${field.type}"`);
      }
    }
    return definition;
  }

  // Register a single definition. Performs validation before returning
  registerDefinition(name: string, dataType: RosDatatype): BinaryDefinition {
    const definition = this._createDefinition(name, dataType);
    if (!this._getDefinitions().finalize()) {
      throw new Error(`Invalid definition "${name}"`);
    }
    return definition;
  }

  registerDefinitions(dataTypes: RosDatatypes): BinaryDefinition[] {
    const definitions = Object.keys(dataTypes).map((type) => {
      return this._createDefinition(type, dataTypes[type]);
    });
    if (!this._getDefinitions().finalize()) {
      throw new Error(`Failed to validate definitions`);
    }
    return definitions;
  }

  getDefinitionCommands(definitionName: string): number[] {
    const definition = this._getDefinitions().get(definitionName);
    if (!definition) {
      throw new Error(`No definition found with type "${definitionName}"`);
    }

    const ret = [];
    const cmds = definition.getCommands();
    for (let i = 0; i < cmds.size(); i++) {
      ret.push(cmds.get(i));
    }
    return ret;
  }

  rewriteMessages(definitionName: string, messages: Message[]): BinaryObjects {
    const bridge = this._getBridge();

    const definition = this._getDefinitions().get(definitionName);
    if (!definition) {
      throw new Error(`No definition found with type "${definitionName}"`);
    }

    const writer = new bridge.MessageWriter();

    // Get memory requirements for all messages
    // See MessageWriter::reserve() for more information
    const totalBytes = sumBy(messages, (m) => m.message.byteLength);
    const maxMessageBytes = maxBy(messages, (m) => m.message.byteLength)?.message.byteLength;
    writer.reserve(definition, messages.length, totalBytes);

    // Allocate a buffer to use to send data to C++ code that is big
    // enough to handle the maximum number of bytes for a single message
    // eslint-disable-next-line no-underscore-dangle
    const inDataPtr = bridge._malloc(maxMessageBytes);
    if (!inDataPtr) {
      throw new Error(`Could not allocate memory for data buffer with size "${maxMessageBytes}"`);
    }

    // Translate messages
    const offsets = messages.map((m) => {
      const { topic } = m;
      const data: ArrayBuffer = m.message as any;
      const dataLength = data.byteLength;

      const view = new Uint8Array(data);
      bridge.HEAPU8.set(view, inDataPtr); // requires typed array

      const offset = writer.write(definition, inDataPtr, dataLength);
      if (offset < 0) {
        throw new Error(
          `Could not write message from "${topic}" with undefined type "${definitionName}"`,
        );
      }

      return offset;
    });

    // eslint-disable-next-line no-underscore-dangle
    bridge._free(inDataPtr);

    // Copy result data int new arrays so we can access them
    // after the writer has been deleted (a few lines below).
    const buffer = new Uint8Array(writer.getBuffer()).buffer;
    // Notes:
    //  - TextDecoder overhead makes it more efficient to decode all of the strings in one go, and
    //    split them later (instead of parsing them from binary on access).
    //  - Decoding straight from the WASM heap is a nice performance win over copying the data out
    //    first.
    //  - It's very important that the indices into bigString inside the buffer correspond with
    //    characters returned by bigString.split(). Decoding as utf-8 is possible, and we could
    //    store _codepoint_ indices in the buffer, but we would need our codepoint counting to agree
    //    with the browser's for invalid data, which is difficult.
    let stringBuffer = writer.getBigString();
    if (process.env.NODE_ENV === "test") {
      // Something weird/terrible happening in node environments here... Causes the TextDecoder
      // polyfill we use in tests to malfunction. Doesn't happen on the web.
      stringBuffer = stringBuffer.slice();
    }
    const bigString = new TextDecoder("ascii").decode(stringBuffer);
    writer.delete();

    return {
      dataType: definitionName,
      offsets,
      buffer,
      bigString,
    };
  }
}
