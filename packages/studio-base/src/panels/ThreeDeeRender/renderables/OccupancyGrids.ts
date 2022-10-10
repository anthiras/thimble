// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { toNanoSec } from "@foxglove/rostime";
import { SettingsTreeAction, SettingsTreeFields } from "@foxglove/studio";
import type { RosValue } from "@foxglove/studio-base/players/types";

import { BaseUserData, Renderable } from "../Renderable";
import { Renderer } from "../Renderer";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
// import { rgbaToCssString, SRGBToLinear, stringToRgba } from "../color";
import {
  normalizeHeader,
  normalizePose,
  normalizeInt8Array,
  normalizeTime,
} from "../normalizeMessages";
import {  OccupancyGrid, OCCUPANCY_GRID_DATATYPES, CostmapData, MIR_COST_MAP_DATATYPE } from "../ros"; // ColorRGBA,
import { BaseSettings } from "../settings";

export type LayerSettingsOccupancyGrid = BaseSettings & {
  frameLocked: boolean;
  // minColor: string;
  // maxColor: string;
  // unknownColor: string;
  // invalidColor: string;
  // anotherColor: string;
};

import PNG from 'png-ts';

const INVALID_OCCUPANCY_GRID = "INVALID_OCCUPANCY_GRID";

// const DEFAULT_MIN_COLOR = { r: 1, g: 1, b: 1, a: 1 }; // white
// const DEFAULT_MAX_COLOR = { r: 0, g: 0, b: 0, a: 1 }; // black
// const DEFAULT_UNKNOWN_COLOR = { r: 0.5, g: 0.5, b: 0.5, a: 1 }; // gray
// const DEFAULT_INVALID_COLOR = { r: 1, g: 0, b: 1, a: 1 }; // magenta

// const DEFAULT_MIN_COLOR_STR = rgbaToCssString(DEFAULT_MIN_COLOR);
// const DEFAULT_MAX_COLOR_STR = rgbaToCssString(DEFAULT_MAX_COLOR);
// const DEFAULT_UNKNOWN_COLOR_STR = rgbaToCssString(DEFAULT_UNKNOWN_COLOR);
// const DEFAULT_INVALID_COLOR_STR = rgbaToCssString(DEFAULT_INVALID_COLOR);

const DEFAULT_SETTINGS: LayerSettingsOccupancyGrid = {
  visible: false,
  frameLocked: false,
  // minColor: DEFAULT_MIN_COLOR_STR,
  // maxColor: DEFAULT_MAX_COLOR_STR,
  // unknownColor: DEFAULT_UNKNOWN_COLOR_STR,
  // invalidColor: DEFAULT_INVALID_COLOR_STR,
};

export type OccupancyGridUserData = BaseUserData & {
  settings: LayerSettingsOccupancyGrid;
  topic: string;
  occupancyGrid: OccupancyGrid;
  mesh: THREE.Mesh;
  texture: THREE.DataTexture;
  material: THREE.MeshBasicMaterial;
  pickingMaterial: THREE.ShaderMaterial;
};

export class OccupancyGridRenderable extends Renderable<OccupancyGridUserData> {
  public override dispose(): void {
    this.userData.texture.dispose();
    this.userData.material.dispose();
    this.userData.pickingMaterial.dispose();
  }

  public override details(): Record<string, RosValue> {
    return this.userData.occupancyGrid;
  }
}

export class OccupancyGrids extends SceneExtension<OccupancyGridRenderable> {
  private static geometry: THREE.PlaneGeometry | undefined;

  public constructor(renderer: Renderer) {
    super("foxglove.OccupancyGrids", renderer);

    renderer.addDatatypeSubscriptions(MIR_COST_MAP_DATATYPE, this.handleCostmapData);
    renderer.addDatatypeSubscriptions(OCCUPANCY_GRID_DATATYPES, this.handleOccupancyGrid);
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      if (OCCUPANCY_GRID_DATATYPES.has(topic.datatype)) {
        const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsOccupancyGrid>;

        // prettier-ignore
        const fields: SettingsTreeFields = {
          // minColor: { label: "Min Color", input: "rgba", value: config.minColor ?? DEFAULT_MIN_COLOR_STR },
          // maxColor: { label: "Max Color", input: "rgba", value: config.maxColor ?? DEFAULT_MAX_COLOR_STR },
          // unknownColor: { label: "Unknown Color", input: "rgba", value: config.unknownColor ?? DEFAULT_UNKNOWN_COLOR_STR },
          // invalidColor: { label: "Invalid Color", input: "rgba", value: config.invalidColor ?? DEFAULT_INVALID_COLOR_STR },
          frameLocked: { label: "Frame lock", input: "boolean", value: config.frameLocked ?? false },
        };

        entries.push({
          path: ["topics", topic.name],
          node: {
            label: topic.name,
            icon: "Cells",
            fields,
            visible: config.visible ?? DEFAULT_SETTINGS.visible,
            order: topic.name.toLocaleLowerCase(),
            handler,
          },
        });
      }
    }
    return entries;
  }

  public override handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }

    this.saveSetting(path, action.payload.value);

    // Update the renderable
    const topicName = path[1]!;
    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const prevTransparent = occupancyGridHasTransparency(); // renderable.userData.settings
      const settings = this.renderer.config.topics[topicName] as
        | Partial<LayerSettingsOccupancyGrid>
        | undefined;
      renderable.userData.settings = { ...DEFAULT_SETTINGS, ...settings };

      // Check if the transparency changed and we need to create a new material
      const newTransparent = occupancyGridHasTransparency(); // renderable.userData.settings
      if (prevTransparent !== newTransparent) {
        renderable.userData.material.transparent = newTransparent;
        renderable.userData.material.depthWrite = !newTransparent;
        renderable.userData.material.needsUpdate = true;
      }

      this._updateOccupancyGridRenderable(
        renderable,
        renderable.userData.occupancyGrid,
        renderable.userData.receiveTime,
      );
    }
  };

  private handleCostmapData = (messageEvent: PartialMessageEvent<CostmapData>): void => {
    const new_msg = MirToRos(messageEvent);
    this.handleOccupancyGrid(new_msg);
  }

  private handleOccupancyGrid = (messageEvent: PartialMessageEvent<OccupancyGrid>): void => {
    const topic = messageEvent.topic;
    const occupancyGrid = normalizeOccupancyGrid(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);

    let renderable = this.renderables.get(topic);
    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsOccupancyGrid>
        | undefined;
      const settings = { ...DEFAULT_SETTINGS, ...userSettings };

      const texture = createTexture(occupancyGrid);
      const mesh = createMesh(topic, texture); // , settings
      const material = mesh.material as THREE.MeshBasicMaterial;
      const pickingMaterial = mesh.userData.pickingMaterial as THREE.ShaderMaterial;

      // Create the renderable
      renderable = new OccupancyGridRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(occupancyGrid.header.stamp),
        frameId: this.renderer.normalizeFrameId(occupancyGrid.header.frame_id),
        pose: occupancyGrid.info.origin,
        settingsPath: ["topics", topic],
        settings,
        topic,
        occupancyGrid,
        mesh,
        texture,
        material,
        pickingMaterial,
      });
      renderable.add(mesh);

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    this._updateOccupancyGridRenderable(renderable, occupancyGrid, receiveTime);
  };

  private _updateOccupancyGridRenderable(
    renderable: OccupancyGridRenderable,
    occupancyGrid: OccupancyGrid,
    receiveTime: bigint,
  ): void {
    renderable.userData.occupancyGrid = occupancyGrid;
    renderable.userData.pose = occupancyGrid.info.origin;
    renderable.userData.receiveTime = receiveTime;
    renderable.userData.messageTime = toNanoSec(occupancyGrid.header.stamp);
    renderable.userData.frameId = this.renderer.normalizeFrameId(occupancyGrid.header.frame_id);

    const png_signature = [-119, 80, 78, 71];
    if (occupancyGrid.data[0] == png_signature[0]
      && occupancyGrid.data[1] == png_signature[1]
      && occupancyGrid.data[2] == png_signature[2]
      && occupancyGrid.data[3] == png_signature[3]) {
      const data = new Uint8Array(occupancyGrid.data);
      const pngImage = PNG.load(data);
      const imgData = pngImage.decodePixels();

      var pixels = new Int8Array(imgData.length);

      for (let i = 0; i < pixels.length; i ++) {
        pixels[i] = imgData[i]!;
      }
      occupancyGrid.data = pixels;
    }


    const size = occupancyGrid.info.width * occupancyGrid.info.height;
    if (occupancyGrid.data.length !== size) {
      const message = `OccupancyGrid data length (${occupancyGrid.data.length}) is not equal to width ${occupancyGrid.info.width} * height ${occupancyGrid.info.height}`;
      invalidOccupancyGridError(this.renderer, renderable, message);
      return;
    }

    let texture = renderable.userData.texture;
    const width = occupancyGrid.info.width;
    const height = occupancyGrid.info.height;
    const resolution = occupancyGrid.info.resolution;

    if (width !== texture.image.width || height !== texture.image.height) {
      // The image dimensions changed, regenerate the texture
      texture.dispose();
      texture = createTexture(occupancyGrid);
      renderable.userData.texture = texture;
      renderable.userData.material.map = texture;
    }

    // Update the occupancy grid texture
    updateTexture(renderable.userData.topic,texture, occupancyGrid); // , renderable.userData.settings

    renderable.scale.set(resolution * width, resolution * height, 1);
  }

  public static Geometry(): THREE.PlaneGeometry {
    if (!OccupancyGrids.geometry) {
      OccupancyGrids.geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
      OccupancyGrids.geometry.translate(0.5, 0.5, 0);
      OccupancyGrids.geometry.computeBoundingSphere();
    }
    return OccupancyGrids.geometry;
  }
}

function invalidOccupancyGridError(
  renderer: Renderer,
  renderable: OccupancyGridRenderable,
  message: string,
): void {
  renderer.settings.errors.addToTopic(renderable.userData.topic, INVALID_OCCUPANCY_GRID, message);
}

function createTexture(occupancyGrid: OccupancyGrid): THREE.DataTexture {
  const width = occupancyGrid.info.width;
  const height = occupancyGrid.info.height;
  const size = width * height;
  const rgba = new Uint8ClampedArray(size * 4);
  const texture = new THREE.DataTexture(
    rgba,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
    THREE.UVMapping,
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
    THREE.NearestFilter,
    THREE.LinearFilter,
    1,
    THREE.LinearEncoding, // OccupancyGrid carries linear grayscale values, not sRGB
  );
  texture.generateMipmaps = false;
  return texture;
}

function createMesh(
  topic: string,
  texture: THREE.DataTexture,
  // settings: LayerSettingsOccupancyGrid,
): THREE.Mesh {
  // Create the texture, material, and mesh
  const pickingMaterial = createPickingMaterial(texture);
  const material = createMaterial(texture, topic); // , settings
  const mesh = new THREE.Mesh(OccupancyGrids.Geometry(), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // This overrides the picking material used for `mesh`. See Picker.ts
  mesh.userData.pickingMaterial = pickingMaterial;
  return mesh;
}

// const tempUnknownColor = { r: 0, g: 0, b: 0, a: 0 };
// const tempInvalidColor = { r: 0, g: 0, b: 0, a: 0 };
// const tempMinColor = { r: 0, g: 0, b: 0, a: 0 };
// const tempMaxColor = { r: 0, g: 0, b: 0, a: 0 };

function updateTexture(
  topic: string,
  texture: THREE.DataTexture,
  occupancyGrid: OccupancyGrid,
  // settings: LayerSettingsOccupancyGrid,
): void {
  const size = occupancyGrid.info.width * occupancyGrid.info.height;
  const rgba = texture.image.data;
  // stringToRgba(tempMinColor, settings.minColor);
  // stringToRgba(tempMaxColor, settings.maxColor);
  // stringToRgba(tempUnknownColor, settings.unknownColor);
  // stringToRgba(tempInvalidColor, settings.invalidColor);

  // srgbToLinearUint8(tempMinColor);
  // srgbToLinearUint8(tempMaxColor);
  // srgbToLinearUint8(tempUnknownColor);
  // srgbToLinearUint8(tempInvalidColor);

  const data = occupancyGrid.data;
  switch (topic){
    case "/traffic_map":
      for (let i = 0; i < size; i++) {
        const value = data[i]! & 0xFF;
        const offset = i * 4;
        switch (value){
          case 0:
            rgba[offset + 0] = 0;
            rgba[offset + 1] = 255;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 128;
            break;
          case 100:
            rgba[offset + 0] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 255;
            rgba[offset + 3] = 128;
            break;
          default:
            rgba[offset + 0] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 0;
            break;
        }
      }
      break;
    case "/one_way_map":
      for (let i = 0; i < size; i++) {
        const value = data[i]! & 0xFF;
        const offset = i * 4;
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 128;
        if (value == 255) {
          alpha = 0;
        }
        if ((value & 0b11000111) == 0b11000111) { // 0 degrees
          red |= 0b10000000;
        }

        if ((value & 0b10001111) == 0b10001111) { // +45 degrees
          green |= 0b01000000;
        }

        if ((value & 0b00011111) == 0b00011111) { // +90 degrees
          red |= 0b00100000;
        }

        if ((value & 0b00111110) == 0b00111110) { // +135 degrees
          blue |= 0b10000000;
        }

        if ((value & 0b01111100) == 0b01111100) { // +/-180 degrees
          green |= 0b00100000;
        }

        if ((value & 0b11111000) == 0b11111000) { // -135 degrees
          green |= 0b10000000;
        }

        if ((value & 0b11110001) == 0b11110001) { // -90 degrees
          red |= 0b01000000;
        }

        if ((value & 0b11100011) == 0b11100011) { // -45 degrees
          blue |= 0b01000000;
        }
        rgba[offset + 0] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = blue;
        rgba[offset + 3] = alpha;
      }
      break;
    default:
      for (let i = 0; i < size; i++) {
        const value = data[i]! & 0xFF;
        const offset = i * 4;
        switch (value){
          case 0:
            rgba[offset + 0] = 255;
            rgba[offset + 1] = 255;
            rgba[offset + 2] = 255;
            rgba[offset + 3] = 128;
            break;
          case 224:
            rgba[offset + 0] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 128;
            break;
          case 192:
            rgba[offset + 0] = 255;
            rgba[offset + 1] = 168;
            rgba[offset + 2] = 168;
            rgba[offset + 3] = 128;
            break;
          case 96:
            rgba[offset + 0] = 128;
            rgba[offset + 1] = 128;
            rgba[offset + 2] = 128;
            rgba[offset + 3] = 128;
            break;
          case 95:
            rgba[offset + 0] = 255;
            rgba[offset + 1] = 165;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 128;
            break;
          default:
            rgba[offset + 0] = 0;
            rgba[offset + 1] = 0;
            rgba[offset + 2] = 0;
            rgba[offset + 3] = 0;
            break;
        }
      }
      break;
  }


  texture.needsUpdate = true;
}

function createMaterial(
  texture: THREE.DataTexture,
  topic: string,
  // settings: LayerSettingsOccupancyGrid,
): THREE.MeshBasicMaterial {
  const transparent = occupancyGridHasTransparency(); // settings
  return new THREE.MeshBasicMaterial({
    name: `${topic}:Material`,
    // Enable alpha clipping. Fully transparent (alpha=0) pixels are skipped
    // even when transparency is disabled
    alphaTest: 1e-4,
    depthWrite: !transparent,
    map: texture,
    side: THREE.DoubleSide,
    transparent,
  });
}

function createPickingMaterial(texture: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec4 objectId;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(map, vUv);
        if (color.a == 0.0) {
          discard;
        }
        gl_FragColor = objectId;
      }
    `,
    side: THREE.DoubleSide,
    uniforms: { map: { value: texture }, objectId: { value: [NaN, NaN, NaN, NaN] } },
  });
}

function occupancyGridHasTransparency(): boolean { // settings: LayerSettingsOccupancyGrid
  // stringToRgba(tempMinColor, settings.minColor);
  // stringToRgba(tempMaxColor, settings.maxColor);
  // stringToRgba(tempUnknownColor, settings.unknownColor);
  // stringToRgba(tempInvalidColor, settings.invalidColor);
  return (
    true
  );
}

// function srgbToLinearUint8(color: ColorRGBA): void {
//   color.r = Math.trunc(SRGBToLinear(color.r) * 255);
//   color.g = Math.trunc(SRGBToLinear(color.g) * 255);
//   color.b = Math.trunc(SRGBToLinear(color.b) * 255);
//   color.a = Math.trunc(color.a * 255);
// }

function MirToRos(messageEvent: PartialMessageEvent<CostmapData>) : PartialMessageEvent<OccupancyGrid> {
  console.log("We are here!");
  const occupancy_grid_data = new Int8Array(messageEvent.message.data?.length!);
  const width = messageEvent.message.width!;
  const height = messageEvent.message.height!;
  const offset_x = messageEvent.message.offset_x!;
  const offset_y = messageEvent.message.offset_y!;
  console.log(occupancy_grid_data.length);
  for (let y = 0; y < width; y ++) {
    for (let x = 0; x < height; x ++) {
      const index  = (width * y + x) / 4;
      const offset = 6 - (((width * y + x) % 4) * 2);
      const value = messageEvent.message.data![index] ;
      occupancy_grid_data[(width * y + x)] = (value! >> offset) & 3;
    }
  }

  return {
        topic: messageEvent.topic,
        schemaName: messageEvent.schemaName,
        receiveTime: messageEvent.receiveTime,
        publishTime: messageEvent.publishTime,
        message: {
          header: messageEvent.message.header,
          info: {
            map_load_time: {
              sec: 0,
              nsec: 0,
            },
            resolution: messageEvent.message.resolution,
            width: width,
            height: height,
            origin: {
              position: {x:offset_x, y:offset_y, z:0},
              orientation: {x:
                0, y:0, z:0,w: 1
              }
              ,
            },
          },
          data: occupancy_grid_data,
        },
        sizeInBytes: messageEvent.sizeInBytes,
  };
}

function normalizeOccupancyGrid(message: PartialMessage<OccupancyGrid>): OccupancyGrid {
  const info = message.info ?? {};

  return {
    header: normalizeHeader(message.header),
    info: {
      map_load_time: normalizeTime(info.map_load_time),
      resolution: info.resolution ?? 0,
      width: info.width ?? 0,
      height: info.height ?? 0,
      origin: normalizePose(info.origin),
    },
    data: normalizeInt8Array(message.data),
  };
}
