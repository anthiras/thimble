// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { toNanoSec } from "@foxglove/rostime";
import { PosesInFrame } from "@foxglove/schemas";
import { SettingsTreeAction, SettingsTreeFields, Topic } from "@foxglove/studio";
import type { RosValue } from "@foxglove/studio-base/players/types";

import { BaseUserData, Renderable } from "../Renderable";
import { Renderer } from "../Renderer";
import { PartialMessage, PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { makeRgba, rgbaGradient, rgbaToCssString, stringToRgba } from "../color";
import { POSES_IN_FRAME_DATATYPES } from "../foxglove";
import { vecEqual } from "../math";
import { normalizeHeader, normalizePose, normalizeTime } from "../normalizeMessages";
import {
  PoseArray,
  POSE_ARRAY_DATATYPES,
  ColorRGBA,
  NAV_PATH_DATATYPES,
  Marker,
  NavPath,
  MarkerType,
  MarkerAction,
  MirRobotStatePath,
  MIR_ROBOT_STATE_PATH_DATATYPES,
  MirRobotState,
} from "../ros";
import {
  BaseSettings,
  fieldGradient,
  fieldLineWidth,
  fieldScaleVec3,
  fieldSize,
  PRECISION_DISTANCE,
} from "../settings";
import { makePose, Pose } from "../transforms";
import { Axis, AXIS_LENGTH } from "./Axis";
import { createArrowMarker } from "./Poses";
import { RenderableArrow } from "./markers/RenderableArrow";
import { RenderableLineStrip } from "./markers/RenderableLineStrip";

type GradientRgba = [ColorRGBA, ColorRGBA];
type Gradient = [string, string];
type DisplayType = "axis" | "arrow" | "line";

export type LayerSettingsPoseArray = BaseSettings & {
  type: DisplayType;
  axisScale: number;
  arrowScale: [number, number, number];
  lineWidth: number;
  gradient: Gradient;
  trolley: boolean;
};

const DEFAULT_TROLLEY = false;
const DEFAULT_TYPE: DisplayType = "axis";
const DEFAULT_AXIS_SCALE = AXIS_LENGTH;
const DEFAULT_ARROW_SCALE: THREE.Vector3Tuple = [1, 0.15, 0.15];
const DEFAULT_LINE_WIDTH = 0.2;
const DEFAULT_GRADIENT: GradientRgba = [
  { r: 124 / 255, g: 107 / 255, b: 1, a: 1 },
  { r: 124 / 255, g: 107 / 255, b: 1, a: 0.5 },
];

const MISMATCHED_FRAME_ID = "MISMATCHED_FRAME_ID";

const TIME_ZERO = { sec: 0, nsec: 0 };
const COLOR_WHITE = { r: 1, g: 1, b: 1, a: 1 };

const DEFAULT_GRADIENT_STR: Gradient = [
  rgbaToCssString(DEFAULT_GRADIENT[0]!),
  rgbaToCssString(DEFAULT_GRADIENT[1]!),
];

const DEFAULT_SETTINGS: LayerSettingsPoseArray = {
  visible: false,
  type: DEFAULT_TYPE,
  axisScale: DEFAULT_AXIS_SCALE,
  arrowScale: DEFAULT_ARROW_SCALE,
  lineWidth: DEFAULT_LINE_WIDTH,
  gradient: DEFAULT_GRADIENT_STR,
  trolley: false,
};

const TYPE_OPTIONS = [
  { label: "Axis", value: "axis" },
  { label: "Arrow", value: "arrow" },
  { label: "Line", value: "line" },
];

const tempColor1 = makeRgba();
const tempColor2 = makeRgba();
const tempColor3 = makeRgba();

export type PoseArrayUserData = BaseUserData & {
  settings: LayerSettingsPoseArray;
  topic: string;
  poseArrayMessage: PoseArray;
  originalMessage: Record<string, RosValue>;
  axes: Axis[];
  arrows: RenderableArrow[];
  trolley_arrows: RenderableArrow[];
  trolley_numbers: number[];
  robot_angle: number[];
  trolley_length: number;
  lineStrip?: RenderableLineStrip;
};

export class PoseArrayRenderable extends Renderable<PoseArrayUserData> {
  public override dispose(): void {
    this.userData.axes.forEach((axis) => axis.dispose());
    this.userData.arrows.forEach((arrow) => arrow.dispose());
    this.userData.lineStrip?.dispose();
    super.dispose();
  }

  public override details(): Record<string, RosValue> {
    return this.userData.originalMessage;
  }

  public removeArrows(): void {
    for (const arrow of this.userData.arrows) {
      this.remove(arrow);
      arrow.dispose();
    }
    this.userData.arrows.length = 0;
  }

  public removeAxes(): void {
    for (const axis of this.userData.axes) {
      this.remove(axis);
      axis.dispose();
    }
    this.userData.axes.length = 0;
  }

  public removeTrolley(): void {
    for (const trolley_arrow of this.userData.trolley_arrows) {
      this.remove(trolley_arrow);
      trolley_arrow.dispose();
    }
    this.userData.trolley_arrows.length = 0;
  }

  public removeLineStrip(): void {
    if (this.userData.lineStrip) {
      this.remove(this.userData.lineStrip);
      this.userData.lineStrip.dispose();
      this.userData.lineStrip = undefined;
    }
  }
}

export class PoseArrays extends SceneExtension<PoseArrayRenderable> {
  public constructor(renderer: Renderer) {
    super("foxglove.PoseArrays", renderer);

    renderer.addDatatypeSubscriptions(POSE_ARRAY_DATATYPES, this.handlePoseArray);
    renderer.addDatatypeSubscriptions(POSES_IN_FRAME_DATATYPES, this.handlePosesInFrame);
    renderer.addDatatypeSubscriptions(NAV_PATH_DATATYPES, this.handleNavPath);
    renderer.addDatatypeSubscriptions(MIR_ROBOT_STATE_PATH_DATATYPES, this.handleMirRobotStatePath);
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      if (
        POSE_ARRAY_DATATYPES.has(topic.schemaName) ||
        NAV_PATH_DATATYPES.has(topic.schemaName) ||
        POSES_IN_FRAME_DATATYPES.has(topic.schemaName) ||
        MIR_ROBOT_STATE_PATH_DATATYPES.has(topic.schemaName)
      ) {
        const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsPoseArray>;
        const displayType = config.type ?? getDefaultType(topic);
        const { axisScale, lineWidth } = config;
        const arrowScale = config.arrowScale ?? DEFAULT_ARROW_SCALE;
        const gradient = config.gradient ?? DEFAULT_GRADIENT_STR;
        const trolley_bool = config.trolley ?? DEFAULT_TROLLEY;

        const fields: SettingsTreeFields = {
          type: { label: "Type", input: "select", options: TYPE_OPTIONS, value: displayType },
        };
        switch (displayType) {
          case "axis":
            fields["axisScale"] = fieldSize("Scale", axisScale, PRECISION_DISTANCE);
            break;
          case "arrow":
            fields["arrowScale"] = fieldScaleVec3("Scale", arrowScale);
            break;
          case "line":
            fields["lineWidth"] = fieldLineWidth("Line Width", lineWidth, DEFAULT_LINE_WIDTH);
            break;
        }

        // Axis does not currently support gradients. This could possibly be done with tinting
        if (displayType !== "axis") {
          fields["gradient"] = fieldGradient("Gradient", gradient);
        }

        fields["trolley"] = {
          label: "Using trolley",
          input: "boolean",
          value: trolley_bool,
        };

        entries.push({
          path: ["topics", topic.name],
          node: {
            label: topic.name,
            icon: NAV_PATH_DATATYPES.has(topic.schemaName) ? "Timeline" : "Flag",
            fields,
            visible: config.visible ?? DEFAULT_SETTINGS.visible,
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
      const settings = this.renderer.config.topics[topicName] as
        | Partial<LayerSettingsPoseArray>
        | undefined;
      this._updatePoseArrayRenderable(
        renderable,
        renderable.userData.poseArrayMessage,
        renderable.userData.originalMessage,
        renderable.userData.receiveTime,
        { ...DEFAULT_SETTINGS, ...settings },
      );
    }
  };

  private handlePoseArray = (messageEvent: PartialMessageEvent<PoseArray>): void => {
    const poseArrayMessage = normalizePoseArray(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPoseArray(messageEvent.topic, poseArrayMessage, messageEvent.message, receiveTime);
  };

  private handleMirRobotStatePath = (
    messageEvent: PartialMessageEvent<MirRobotStatePath>,
  ): void => {
    const poseArrayMessage = normalizeMirPoseArray(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    const topic = messageEvent.topic;
    const originalMessage: Record<string, RosValue> = messageEvent.message;

    let renderable = this.renderables.get(topic);
    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsPoseArray>
        | undefined;
      const defaultType = { type: getDefaultType(this.renderer.topicsByName?.get(topic)) };
      const settings = { ...DEFAULT_SETTINGS, ...defaultType, ...userSettings };

      renderable = new PoseArrayRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(poseArrayMessage.header.stamp),
        frameId: this.renderer.normalizeFrameId(poseArrayMessage.header.frame_id),
        pose: makePose(),
        settingsPath: ["topics", topic],
        settings,
        topic,
        poseArrayMessage,
        originalMessage,
        axes: [],
        arrows: [],
        trolley_numbers: [],
        trolley_arrows: [],
        robot_angle: [],
        trolley_length: 0,
      });

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    if (messageEvent.message.has_trolley === true) {
      // Bla
      renderable.userData.trolley_length = messageEvent.message.robot_to_trolley_dist ?? 0;

      renderable.userData.robot_angle = [];
      messageEvent.message.path?.forEach((_value) => {
        renderable!.userData.robot_angle.push(_value.pose_theta ?? 0);
      });

      renderable.userData.trolley_numbers = [];
      messageEvent.message.path?.forEach((_value) => {
        renderable!.userData.trolley_numbers.push(_value.hook_angle ?? 0);
      });
    }

    this._updatePoseArrayRenderable(
      renderable,
      poseArrayMessage,
      originalMessage,
      receiveTime,
      renderable.userData.settings,
    );
  };

  private handleNavPath = (messageEvent: PartialMessageEvent<NavPath>): void => {
    if (!validateNavPath(messageEvent, this.renderer)) {
      return;
    }

    const poseArrayMessage = normalizeNavPathToPoseArray(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPoseArray(messageEvent.topic, poseArrayMessage, messageEvent.message, receiveTime);
  };

  private handlePosesInFrame = (messageEvent: PartialMessageEvent<PosesInFrame>): void => {
    const poseArrayMessage = normalizePosesInFrameToPoseArray(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    this.addPoseArray(messageEvent.topic, poseArrayMessage, messageEvent.message, receiveTime);
  };

  private addPoseArray(
    topic: string,
    poseArrayMessage: PoseArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
  ): void {
    let renderable = this.renderables.get(topic);
    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = this.renderer.config.topics[topic] as
        | Partial<LayerSettingsPoseArray>
        | undefined;
      const defaultType = { type: getDefaultType(this.renderer.topicsByName?.get(topic)) };
      const settings = { ...DEFAULT_SETTINGS, ...defaultType, ...userSettings };

      renderable = new PoseArrayRenderable(topic, this.renderer, {
        receiveTime,
        messageTime: toNanoSec(poseArrayMessage.header.stamp),
        frameId: this.renderer.normalizeFrameId(poseArrayMessage.header.frame_id),
        pose: makePose(),
        settingsPath: ["topics", topic],
        settings,
        topic,
        poseArrayMessage,
        originalMessage,
        axes: [],
        arrows: [],
        trolley_numbers: [],
        trolley_arrows: [],
        robot_angle: [],
        trolley_length: 0,
      });

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    this._updatePoseArrayRenderable(
      renderable,
      poseArrayMessage,
      originalMessage,
      receiveTime,
      renderable.userData.settings,
    );
  }

  private _createAxesToMatchPoses(
    renderable: PoseArrayRenderable,
    poseArray: PoseArray,
    topic: string,
  ): void {
    const scale = renderable.userData.settings.axisScale * (1 / AXIS_LENGTH);

    // Update the scale and visibility of existing AxisRenderables as needed
    const existingUpdateCount = Math.min(renderable.userData.axes.length, poseArray.poses.length);
    for (let i = 0; i < existingUpdateCount; i++) {
      const axis = renderable.userData.axes[i]!;
      axis.visible = true;
      axis.scale.set(scale, scale, scale);
    }

    // Create any AxisRenderables as needed
    for (let i = renderable.userData.axes.length; i < poseArray.poses.length; i++) {
      const axis = new Axis(topic, this.renderer);
      renderable.userData.axes.push(axis);
      renderable.add(axis);

      // Set the scale for each new axis
      axis.scale.set(scale, scale, scale);
    }

    // Hide any AxisRenderables as needed
    for (let i = poseArray.poses.length; i < renderable.userData.axes.length; i++) {
      const axis = renderable.userData.axes[i]!;
      axis.visible = false;
    }
  }

  private _createArrowsToMatchPoses(
    renderable: PoseArrayRenderable,
    poseArray: PoseArray,
    topic: string,
    colorStart: ColorRGBA,
    colorEnd: ColorRGBA,
  ): void {
    // Generate a Marker with the right scale and color
    const createArrowMarkerFromIndex = (i: number): Marker => {
      const t = i / (poseArray.poses.length - 1);
      const color = rgbaGradient(tempColor3, colorStart, colorEnd, t);
      return createArrowMarker(renderable.userData.settings.arrowScale, color);
    };

    // Update the arrowMarker of existing RenderableArrow as needed
    const existingUpdateCount = Math.min(renderable.userData.arrows.length, poseArray.poses.length);
    for (let i = 0; i < existingUpdateCount; i++) {
      const arrowMarker = createArrowMarkerFromIndex(i);
      const arrow = renderable.userData.arrows[i]!;
      arrow.visible = true;
      arrow.update(arrowMarker, undefined);
    }

    // Create any RenderableArrow as needed
    for (let i = renderable.userData.arrows.length; i < poseArray.poses.length; i++) {
      const arrowMarker = createArrowMarkerFromIndex(i);
      const arrow = new RenderableArrow(topic, arrowMarker, undefined, this.renderer);
      renderable.userData.arrows.push(arrow);
      renderable.add(arrow);
    }

    // Hide any RenderableArrow as needed
    for (let i = poseArray.poses.length; i < renderable.userData.arrows.length; i++) {
      const arrow = renderable.userData.arrows[i]!;
      arrow.visible = false;
    }
  }

  private _createTrolleyArrowsToMatchPoses(
    renderable: PoseArrayRenderable,
    poseArray: PoseArray,
    topic: string,
  ): void {
    const color: ColorRGBA = { r: 0, g: 0, b: 1, a: 1 };
    // Update the arrowMarker of existing RenderableArrow as needed
    const existingUpdateCount = Math.min(
      renderable.userData.trolley_arrows.length,
      poseArray.poses.length,
    );
    for (let i = 0; i < existingUpdateCount; i++) {
      const arrowMarker = createArrowMarker(
        [renderable.userData.trolley_length, 0.025, 0.025],
        color,
      );
      const arrow = renderable.userData.trolley_arrows[i]!;
      arrow.visible = true;
      arrow.update(arrowMarker, undefined);
    }

    // Create any RenderableArrow as needed
    for (let i = renderable.userData.trolley_arrows.length; i < poseArray.poses.length; i++) {
      const arrowMarker = createArrowMarker(
        [renderable.userData.trolley_length, 0.025, 0.025],
        color,
      );
      const arrow = new RenderableArrow(topic, arrowMarker, undefined, this.renderer);
      renderable.userData.trolley_arrows.push(arrow);
      renderable.add(arrow);
    }

    // Hide any RenderableArrow as needed
    for (let i = poseArray.poses.length; i < renderable.userData.trolley_arrows.length; i++) {
      const arrow = renderable.userData.trolley_arrows[i]!;
      arrow.visible = false;
    }
  }

  private _updatePoseArrayRenderable(
    renderable: PoseArrayRenderable,
    poseArrayMessage: PoseArray,
    originalMessage: Record<string, RosValue>,
    receiveTime: bigint,
    settings: LayerSettingsPoseArray,
  ): void {
    renderable.userData.receiveTime = receiveTime;
    renderable.userData.messageTime = toNanoSec(poseArrayMessage.header.stamp);
    renderable.userData.frameId = this.renderer.normalizeFrameId(poseArrayMessage.header.frame_id);
    renderable.userData.poseArrayMessage = poseArrayMessage;
    renderable.userData.originalMessage = originalMessage;

    const { topic, settings: prevSettings } = renderable.userData;
    const axisOrArrowSettingsChanged =
      settings.trolley !== prevSettings.trolley ||
      settings.type !== prevSettings.type ||
      settings.axisScale !== prevSettings.axisScale ||
      !vecEqual(settings.arrowScale, prevSettings.arrowScale) ||
      !vecEqual(settings.gradient, prevSettings.gradient) ||
      (renderable.userData.arrows.length === 0 && renderable.userData.axes.length === 0);

    renderable.userData.settings = settings;

    const colorStart = stringToRgba(tempColor1, settings.gradient[0]);
    const colorEnd = stringToRgba(tempColor2, settings.gradient[1]);

    if (axisOrArrowSettingsChanged) {
      if (renderable.userData.settings.trolley) {
        renderable.removeTrolley();
      }
      switch (renderable.userData.settings.type) {
        case "axis":
          renderable.removeArrows();
          renderable.removeLineStrip();
          break;
        case "arrow":
          renderable.removeAxes();
          renderable.removeLineStrip();
          break;
        case "line":
          {
            renderable.removeArrows();
            renderable.removeAxes();

            const lineStripMarker = createLineStripMarker(
              poseArrayMessage,
              settings.lineWidth,
              colorStart,
              colorEnd,
            );

            // Create a RenderableLineStrip if needed
            if (!renderable.userData.lineStrip) {
              const lineStrip = new RenderableLineStrip(
                topic,
                lineStripMarker,
                undefined,
                this.renderer,
              );
              renderable.userData.lineStrip = lineStrip;
              renderable.add(lineStrip);
            }

            renderable.userData.lineStrip.update(lineStripMarker, undefined);
          }
          break;
      }
    }

    // Update the pose for each pose renderable
    if (settings.trolley) {
      this._createTrolleyArrowsToMatchPoses(renderable, poseArrayMessage, topic);
      for (let i = 0; i < poseArrayMessage.poses.length; i++) {
        setObjectPoseTrolley(
          renderable.userData.trolley_arrows[i]!,
          poseArrayMessage.poses[i]!,
          renderable.userData.trolley_numbers[i]!,
          renderable.userData.robot_angle[i]!,
        );
      }
    }
    switch (settings.type) {
      case "axis":
        this._createAxesToMatchPoses(renderable, poseArrayMessage, topic);
        for (let i = 0; i < poseArrayMessage.poses.length; i++) {
          setObjectPose(renderable.userData.axes[i]!, poseArrayMessage.poses[i]!);
        }
        break;
      case "arrow":
        this._createArrowsToMatchPoses(renderable, poseArrayMessage, topic, colorStart, colorEnd);
        for (let i = 0; i < poseArrayMessage.poses.length; i++) {
          setObjectPose(renderable.userData.arrows[i]!, poseArrayMessage.poses[i]!);
        }
        break;
      case "line": {
        const lineStripMarker = createLineStripMarker(
          poseArrayMessage,
          settings.lineWidth,
          colorStart,
          colorEnd,
        );
        renderable.userData.lineStrip?.update(lineStripMarker, undefined);
        break;
      }
    }
  }
}

function getDefaultType(topic: Topic | undefined): DisplayType {
  return topic != undefined && NAV_PATH_DATATYPES.has(topic.schemaName) ? "line" : DEFAULT_TYPE;
}

function setObjectPose(object: THREE.Object3D, pose: Pose): void {
  const p = pose.position;
  const q = pose.orientation;
  object.position.set(p.x, p.y, p.z);
  object.quaternion.set(q.x, q.y, q.z, q.w);
  object.updateMatrix();
}

function setObjectPoseTrolley(
  object: THREE.Object3D,
  pose: Pose,
  trolley_angle: number,
  robot_angle: number,
): void {
  const p = pose.position;
  object.position.set(p.x, p.y, p.z);

  object.quaternion.setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    robot_angle + trolley_angle + Math.PI,
  );
  object.updateMatrix();
}

function createLineStripMarker(
  message: PoseArray,
  lineWidth: number,
  colorStart: ColorRGBA,
  colorEnd: ColorRGBA,
): Marker {
  // Create a gradient of colors for the line strip
  const colors: ColorRGBA[] = [];
  for (let i = 0; i < message.poses.length; i++) {
    const t = i / (message.poses.length - 1);
    colors.push(rgbaGradient(makeRgba(), colorStart, colorEnd, t));
  }

  return {
    header: message.header,
    ns: "",
    id: 0,
    type: MarkerType.LINE_STRIP,
    action: MarkerAction.ADD,
    pose: makePose(),
    scale: { x: lineWidth, y: 1, z: 1 },
    color: COLOR_WHITE,
    lifetime: TIME_ZERO,
    frame_locked: true,
    points: message.poses.map((pose) => pose.position),
    colors,
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function normalizeMirPoseArray(
  poseArray: PartialMessage<MirRobotStatePath> | undefined,
): PoseArray {
  if (!poseArray) {
    return { header: normalizeHeader(undefined), poses: [] };
  }
  return {
    header: normalizeHeader(poseArray.header),
    poses: poseArray.path?.map((p) => normalizeMirPose(p)) ?? [],
  };
}

function normalizeMirPose(input_pose: PartialMessage<MirRobotState> | undefined): Pose {
  if (!input_pose) {
    return normalizePose(undefined);
  }
  const q1 = new THREE.Quaternion();
  const euler = new THREE.Euler(-1 * (input_pose.velocity_theta ?? 0), 0, input_pose.pose_theta);
  q1.setFromEuler(euler);
  return {
    position: {
      x: input_pose.pose_x ?? 0,
      y: input_pose.pose_y ?? 0,
      z: input_pose.velocity_x ?? 0,
    },
    orientation: q1,
  };
}

function normalizePoseArray(poseArray: PartialMessage<PoseArray>): PoseArray {
  return {
    header: normalizeHeader(poseArray.header),
    poses: poseArray.poses?.map((p) => normalizePose(p)) ?? [],
  };
}

function normalizeNavPathToPoseArray(navPath: PartialMessage<NavPath>): PoseArray {
  return {
    header: normalizeHeader(navPath.header),
    poses: navPath.poses?.map((p) => normalizePose(p.pose)) ?? [],
  };
}

function normalizePosesInFrameToPoseArray(poseArray: PartialMessage<PosesInFrame>): PoseArray {
  return {
    header: { stamp: normalizeTime(poseArray.timestamp), frame_id: poseArray.frame_id ?? "" },
    poses: poseArray.poses?.map(normalizePose) ?? [],
  };
}

function validateNavPath(messageEvent: PartialMessageEvent<NavPath>, renderer: Renderer): boolean {
  const { topic, message: navPath } = messageEvent;
  if (navPath.poses) {
    const baseFrameId = renderer.normalizeFrameId(navPath.header?.frame_id ?? "");
    for (const pose of navPath.poses) {
      const curFrameId = renderer.normalizeFrameId(pose.header?.frame_id ?? "");
      if (baseFrameId !== curFrameId) {
        renderer.settings.errors.addToTopic(
          topic,
          MISMATCHED_FRAME_ID,
          `Path frame does not match frames of all poses. "${baseFrameId}" != "${curFrameId}"`,
        );
      }
    }
  }
  return true;
}
