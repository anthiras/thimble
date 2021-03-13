// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import CheckboxBlankOutlineIcon from "@mdi/svg/svg/checkbox-blank-outline.svg";
import CheckboxMarkedIcon from "@mdi/svg/svg/checkbox-marked.svg";
import CloseIcon from "@mdi/svg/svg/close.svg";
import MenuDownIcon from "@mdi/svg/svg/menu-down.svg";
import WavesIcon from "@mdi/svg/svg/waves.svg";
import cx from "classnames";
import { last, uniq } from "lodash";
import styled from "styled-components";

import ImageCanvas from "./ImageCanvas";
import imageCanvasStyles from "./ImageCanvas.module.scss";
import helpContent from "./index.help.md";
import style from "./index.module.scss";
import {
  getCameraInfoTopic,
  getCameraNamespace,
  getRelatedMarkerTopics,
  getMarkerOptions,
  groupTopics,
} from "./util";
import * as PanelAPI from "@foxglove-studio/app/PanelAPI";
import Autocomplete from "@foxglove-studio/app/components/Autocomplete";
import Dropdown from "@foxglove-studio/app/components/Dropdown";
import DropdownItem from "@foxglove-studio/app/components/Dropdown/DropdownItem";
import dropDownStyles from "@foxglove-studio/app/components/Dropdown/index.module.scss";
import EmptyState from "@foxglove-studio/app/components/EmptyState";
import { useExperimentalFeature } from "@foxglove-studio/app/components/ExperimentalFeatures";
import Flex from "@foxglove-studio/app/components/Flex";
import Icon from "@foxglove-studio/app/components/Icon";
import { Item, SubMenu } from "@foxglove-studio/app/components/Menu";
import { useMessagePipeline } from "@foxglove-studio/app/components/MessagePipeline";
import Panel from "@foxglove-studio/app/components/Panel";
import PanelToolbar from "@foxglove-studio/app/components/PanelToolbar";
import { getGlobalHooks } from "@foxglove-studio/app/loadWebviz";
import { Message, TypedMessage } from "@foxglove-studio/app/players/types";
import inScreenshotTests from "@foxglove-studio/app/stories/inScreenshotTests";
import colors from "@foxglove-studio/app/styles/colors.module.scss";
import { CameraInfo } from "@foxglove-studio/app/types/Messages";
import { SaveConfig } from "@foxglove-studio/app/types/panels";
import filterMap from "@foxglove-studio/app/util/filterMap";
import { useShallowMemo, useDeepMemo } from "@foxglove-studio/app/util/hooks";
import naturalSort from "@foxglove-studio/app/util/naturalSort";
import { getTopicsByTopicName } from "@foxglove-studio/app/util/selectors";
import { colors as sharedColors } from "@foxglove-studio/app/util/sharedStyleConstants";
import { getSynchronizingReducers } from "@foxglove-studio/app/util/synchronizeMessages";
import { formatTimeRaw } from "@foxglove-studio/app/util/time";
import toggle from "@foxglove-studio/app/util/toggle";

const { useMemo, useCallback } = React;

type DefaultConfig = {
  cameraTopic: string;
  enabledMarkerTopics: string[];
  customMarkerTopicOptions?: string[];
  scale: number;
  synchronize: boolean;
};

export type ImageViewPanelHooks = {
  defaultConfig: DefaultConfig;
  imageMarkerDatatypes: string[];
};
const DEFAULT_PANEL_HOOKS = { imageMarkerDatatypes: [] };

export type Config = DefaultConfig & {
  panelHooks?: ImageViewPanelHooks;
  transformMarkers: boolean;
  mode: "fit" | "fill" | "other" | null;
  zoomPercentage: number | null | undefined;
  offset: number[] | null | undefined;
  saveStoryConfig?: () => void;
};

export type SaveImagePanelConfig = SaveConfig<Config>;

type Props = {
  config: Config;
  saveConfig: SaveImagePanelConfig;
};

const TopicTimestampSpan = styled.span`
  padding: 0px 15px 0px 0px;
  font-size: 10px;
  font-style: italic;
`;

const SEmptyStateWrapper = styled.div`
  width: 100%;
  height: 100%;
  position: absolute;
  z-index: 200;
  background: ${sharedColors.DARK2};
  display: flex;
  align-items: center;
  justify-content: center;
`;

const TopicTimestamp = ({
  text,
  style: styleObj,
}: {
  text: string;
  style?: {
    [key: string]: string;
  };
}) => (text === "" ? null : <TopicTimestampSpan style={styleObj}>{text}</TopicTimestampSpan>);

const BottomBar = ({ children }: { children?: React.ReactNode }) => (
  <div
    className={cx(imageCanvasStyles["bottom-bar"], {
      [imageCanvasStyles.inScreenshotTests]: inScreenshotTests(),
    })}
  >
    {children}
  </div>
);

const ToggleComponent = ({
  text,
  disabled = false,
  dataTest,
}: {
  text: string;
  disabled?: boolean;
  dataTest?: string;
}) => {
  return (
    <button
      style={{ maxWidth: "100%", padding: "4px 8px" }}
      className={cx({ disabled })}
      data-test={dataTest}
    >
      <span className={dropDownStyles.title}>{text}</span>
      <Icon style={{ marginLeft: 4 }}>
        <MenuDownIcon style={{ width: 14, height: 14, opacity: 0.5 }} />
      </Icon>
    </button>
  );
};

// Group image topics by the first component of their name

function renderEmptyState(
  cameraTopic: string,
  markerTopics: string[],
  shouldSynchronize: boolean,
  messagesByTopic: {
    [topic: string]: Message[];
  },
) {
  return (
    <SEmptyStateWrapper>
      <EmptyState>
        Waiting for images {markerTopics.length > 0 && "and markers"} on:
        <ul>
          <li>
            <code>{cameraTopic}</code>
          </li>
          {markerTopics.sort().map((m) => (
            <li key={m}>
              <code>{m}</code>
            </li>
          ))}
        </ul>
        {shouldSynchronize && (
          <>
            <p>
              Synchronization is enabled, so all messages with <code>header.stamp</code>s must match
              exactly.
            </p>
            <ul>
              {Object.keys(messagesByTopic).map((topic) => (
                <li key={topic}>
                  <code>{topic}</code>:{" "}
                  {messagesByTopic[topic] && messagesByTopic[topic].length
                    ? messagesByTopic[topic]
                        .map((
                          { message }, // In some cases, a user may have subscribed to a topic that does not include a header stamp.
                        ) =>
                          message?.header?.stamp
                            ? formatTimeRaw(message.header.stamp)
                            : "[ unknown ]",
                        )
                        .join(", ")
                    : "no messages"}
                </li>
              ))}
            </ul>
          </>
        )}
      </EmptyState>
    </SEmptyStateWrapper>
  );
}

function useOptionallySynchronizedMessages(
  shouldSynchronize: boolean,
  topics: readonly PanelAPI.RequestedTopic[],
) {
  const memoizedTopics = useDeepMemo(topics);
  const reducers = useMemo(
    () =>
      shouldSynchronize
        ? getSynchronizingReducers(
            memoizedTopics.map((request) =>
              typeof request === "string" ? request : request.topic,
            ),
          )
        : {
            restore: (previousValue) => ({
              messagesByTopic: previousValue ? previousValue.messagesByTopic : {},
              synchronizedMessages: null,
            }),
            addMessage: ({ messagesByTopic }, newMessage) => ({
              messagesByTopic: { ...messagesByTopic, [newMessage.topic]: [newMessage] },
              synchronizedMessages: null,
            }),
          },
    [shouldSynchronize, memoizedTopics],
  );
  return PanelAPI.useMessageReducer({
    topics,
    ...reducers,
  });
}

const AddTopic = ({
  onSelectTopic,
  topics,
}: {
  onSelectTopic: (arg0: string) => void;
  topics: string[];
}) => {
  return (
    <div style={{ padding: "8px 12px", height: "31px" }}>
      <Autocomplete
        placeholder="Add topic"
        items={topics}
        onSelect={onSelectTopic}
        getItemValue={(s) => String(s)}
        getItemText={(s) => String(s)}
      />
    </div>
  );
};

const NO_CUSTOM_OPTIONS: any = [];

function ImageView(props: Props) {
  const { config, saveConfig } = props;
  const {
    scale,
    synchronize,
    cameraTopic,
    enabledMarkerTopics,
    panelHooks,
    transformMarkers,
    customMarkerTopicOptions = NO_CUSTOM_OPTIONS,
  } = config;
  const { topics } = PanelAPI.useDataSourceInfo();
  const isDemoMode = useExperimentalFeature("demoMode");
  const cameraTopicFullObject = useMemo(() => getTopicsByTopicName(topics)[cameraTopic], [
    cameraTopic,
    topics,
  ]);

  // Namespaces represent marker topics based on the camera topic prefix (e.g. "/camera_front_medium")
  const { allCameraNamespaces, imageTopicsByNamespace } = useMemo(() => {
    const imageTopics = (topics ?? []).filter(({ datatype }) =>
      ["sensor_msgs/Image", "sensor_msgs/CompressedImage"].includes(datatype),
    );
    const topicsByNamespace = groupTopics(imageTopics);
    return {
      imageTopicsByNamespace: topicsByNamespace,
      allCameraNamespaces: [...topicsByNamespace.keys()],
    };
  }, [topics]);

  const { imageMarkerDatatypes } =
    panelHooks || (getGlobalHooks() as any).perPanelHooks().ImageView || DEFAULT_PANEL_HOOKS;
  const defaultAvailableMarkerTopics = useMemo(
    () => getMarkerOptions(cameraTopic, topics, allCameraNamespaces, imageMarkerDatatypes),
    [cameraTopic, topics, allCameraNamespaces, imageMarkerDatatypes],
  );
  const availableAndEnabledMarkerTopics = useShallowMemo(
    uniq([
      ...defaultAvailableMarkerTopics,
      ...customMarkerTopicOptions,
      ...enabledMarkerTopics,
    ]).sort(),
  );
  const onToggleMarkerName = useCallback(
    (markerTopic: string) => {
      saveConfig({ enabledMarkerTopics: toggle(enabledMarkerTopics, markerTopic) });
    },
    [saveConfig, enabledMarkerTopics],
  );

  const onChangeCameraTopic = useCallback(
    (newCameraTopic: string) => {
      const newAvailableMarkerTopics = getMarkerOptions(
        newCameraTopic,
        topics,
        allCameraNamespaces,
        imageMarkerDatatypes,
      );

      const newEnabledMarkerTopics = getRelatedMarkerTopics(
        enabledMarkerTopics,
        newAvailableMarkerTopics,
      );
      saveConfig({
        cameraTopic: newCameraTopic,
        transformMarkers: (getGlobalHooks() as any)
          .perPanelHooks()
          .ImageView.canTransformMarkersByTopic(newCameraTopic),

        enabledMarkerTopics: newEnabledMarkerTopics,
      });
    },
    [topics, allCameraNamespaces, imageMarkerDatatypes, enabledMarkerTopics, saveConfig],
  );

  const onChangeScale = useCallback(
    (newScale: number) => {
      saveConfig({ scale: newScale });
    },
    [saveConfig],
  );

  const onToggleSynchronize = useCallback(() => {
    saveConfig({ synchronize: !config.synchronize });
  }, [saveConfig, config.synchronize]);

  const imageTopicDropdown = useMemo(() => {
    const cameraNamespace = getCameraNamespace(cameraTopic);

    if (!imageTopicsByNamespace || imageTopicsByNamespace.size === 0) {
      return (
        <Dropdown
          toggleComponent={
            <ToggleComponent
              dataTest={"topics-dropdown"}
              text={cameraTopic || "no image topics yet"}
              disabled
            />
          }
        />
      );
    }

    const items = [...imageTopicsByNamespace.keys()].sort().map((group) => {
      const imageTopics = imageTopicsByNamespace.get(group);
      if (!imageTopics) {
        return null;
      } // satisfy flow
      imageTopics.sort(naturalSort("name"));

      // place rectified topic above other imageTopics
      return (
        <SubMenu
          direction="right"
          key={group}
          text={group}
          checked={group === cameraNamespace}
          dataTest={group.substr(1)}
        >
          {imageTopics.map((topic) => {
            return (
              <DropdownItem key={topic.name} value={topic.name}>
                <Item
                  checked={topic.name === cameraTopic}
                  onClick={() => onChangeCameraTopic(topic.name)}
                >
                  {topic.name}
                </Item>
              </DropdownItem>
            );
          })}
        </SubMenu>
      );
    });
    return (
      <Dropdown
        toggleComponent={<ToggleComponent dataTest={"topics-dropdown"} text={cameraTopic} />}
      >
        {items}
      </Dropdown>
    );
  }, [cameraTopic, imageTopicsByNamespace, onChangeCameraTopic]);

  const cameraInfoTopic = getCameraInfoTopic(cameraTopic);
  const cameraInfo: CameraInfo | null | undefined = PanelAPI.useMessageReducer({
    topics: cameraInfoTopic ? [cameraInfoTopic] : [],
    restore: useCallback((value: any) => value, []) as any,
    addMessage: useCallback((value, { message }: TypedMessage<CameraInfo>) => message, []),
  });

  const shouldSynchronize = config.synchronize && enabledMarkerTopics.length > 0;
  const imageAndMarkerTopics = useShallowMemo([
    { topic: cameraTopic, imageScale: scale },
    ...enabledMarkerTopics,
  ]);
  const { messagesByTopic, synchronizedMessages } = useOptionallySynchronizedMessages(
    shouldSynchronize,
    imageAndMarkerTopics,
  );

  const markersToRender: Message[] = useMemo(
    () =>
      shouldSynchronize
        ? synchronizedMessages
          ? enabledMarkerTopics.map((topic) => synchronizedMessages[topic])
          : []
        : filterMap(enabledMarkerTopics, (topic) => last(messagesByTopic[topic])),
    [enabledMarkerTopics, messagesByTopic, shouldSynchronize, synchronizedMessages],
  );

  // Timestamps are displayed for informational purposes in the markers menu
  const renderedMarkerTimestamps = useMemo(() => {
    const stamps = {};
    for (const { topic, message } of markersToRender) {
      // In some cases, a user may have subscribed to a topic that does not include a header stamp.
      (stamps as any)[topic] = message?.header?.stamp
        ? formatTimeRaw(message.header.stamp)
        : "[ not available ]";
    }
    return stamps;
  }, [markersToRender]);

  const addTopicsMenu = useMemo(
    () => (
      <AddTopic
        topics={topics
          .map(({ name }) => name)
          .filter((topic) => !availableAndEnabledMarkerTopics.includes(topic))}
        onSelectTopic={(topic) =>
          saveConfig({
            enabledMarkerTopics: [...enabledMarkerTopics, topic],
            customMarkerTopicOptions: [...customMarkerTopicOptions, topic],
          })
        }
      />
    ),
    [
      topics,
      availableAndEnabledMarkerTopics,
      saveConfig,
      enabledMarkerTopics,
      customMarkerTopicOptions,
    ],
  );

  const markerDropdown = useMemo(() => {
    const missingRequiredCameraInfo = scale !== 1 && !cameraInfo;

    return (
      <Dropdown
        dataTest={"markers-dropdown"}
        closeOnChange={false}
        onChange={onToggleMarkerName}
        value={enabledMarkerTopics}
        text={availableAndEnabledMarkerTopics.length > 0 ? "markers" : "no markers"}
        tooltip={
          missingRequiredCameraInfo
            ? "camera_info is required when image resolution is set to less than 100%.\nResolution can be changed in the panel settings."
            : undefined
        }
        disabled={availableAndEnabledMarkerTopics.length === 0 || missingRequiredCameraInfo}
      >
        {availableAndEnabledMarkerTopics.map((topic) => (
          <Item
            {...{ value: topic }}
            icon={
              enabledMarkerTopics.includes(topic) ? (
                <CheckboxMarkedIcon />
              ) : (
                <CheckboxBlankOutlineIcon />
              )
            }
            key={topic}
            className={style.dropdownItem}
          >
            <span style={{ display: "inline-block", marginRight: "15px" }}>{topic}</span>
            <TopicTimestamp text={(renderedMarkerTimestamps as any)[topic] || ""} />
            {customMarkerTopicOptions.includes(topic) && (
              <Icon
                style={{ position: "absolute", right: "10px" }}
                onClick={() =>
                  saveConfig({
                    enabledMarkerTopics: enabledMarkerTopics.filter(
                      (topicOption) => topicOption !== topic,
                    ),
                    customMarkerTopicOptions: customMarkerTopicOptions.filter(
                      (topicOption: any) => topicOption !== topic,
                    ),
                  })
                }
              >
                <CloseIcon />
              </Icon>
            )}
          </Item>
        ))}
        {addTopicsMenu}
      </Dropdown>
    );
  }, [
    addTopicsMenu,
    availableAndEnabledMarkerTopics,
    cameraInfo,
    customMarkerTopicOptions,
    enabledMarkerTopics,
    onToggleMarkerName,
    renderedMarkerTimestamps,
    saveConfig,
    scale,
  ]);

  const menuContent = useMemo(
    () => (
      <>
        <Item
          icon={synchronize ? <CheckboxMarkedIcon /> : <CheckboxBlankOutlineIcon />}
          onClick={onToggleSynchronize}
        >
          <span>Synchronize images and markers</span>
        </Item>
        <hr />
        <SubMenu direction="right" text={`Image resolution: ${(scale * 100).toFixed()}%`}>
          {[0.2, 0.5, 1].map((value) => {
            return (
              <Item
                {...{ value }}
                key={value}
                checked={scale === value}
                onClick={() => onChangeScale(value)}
              >
                {(value * 100).toFixed()}%
              </Item>
            );
          })}
        </SubMenu>
      </>
    ),
    [scale, onChangeScale, synchronize, onToggleSynchronize],
  );

  const imageMessage = messagesByTopic?.[cameraTopic]?.[0];
  const lastImageMessageRef = React.useRef(imageMessage);
  if (imageMessage) {
    lastImageMessageRef.current = imageMessage;
  }
  // Keep the last image message, if it exists, to render on the ImageCanvas.
  // Improve perf by hiding the ImageCanvas while seeking, instead of unmounting and remounting it.
  const imageMessageToRender = imageMessage || lastImageMessageRef.current;

  const pauseFrame = useMessagePipeline(
    useCallback((messagePipeline) => messagePipeline.pauseFrame, []),
  );
  const onStartRenderImage = useCallback(() => {
    const resumeFrame = pauseFrame("ImageView");
    const onFinishRenderImage = () => {
      resumeFrame();
    };
    return onFinishRenderImage;
  }, [pauseFrame]);

  const rawMarkerData = {
    markers: markersToRender,
    scale,
    transformMarkers,
    cameraInfo: markersToRender.length > 0 ? cameraInfo : null,
  };

  const toolbar = useMemo(() => {
    return (
      <PanelToolbar floating helpContent={helpContent} menuContent={menuContent}>
        <div className={style.controls}>
          {imageTopicDropdown}
          {markerDropdown}
        </div>
      </PanelToolbar>
    );
  }, [imageTopicDropdown, markerDropdown, menuContent]);

  const renderBottomBar = () => {
    const canTransformMarkers = (getGlobalHooks() as any)
      .perPanelHooks()
      .ImageView.canTransformMarkersByTopic(cameraTopic);

    const topicTimestamp = (
      <TopicTimestamp
        style={{ padding: "8px 8px 0px 0px" }}
        text={imageMessage ? formatTimeRaw(imageMessage.message.header.stamp) : ""}
      />
    );

    if (!canTransformMarkers) {
      return <BottomBar>{topicTimestamp}</BottomBar>;
    }

    return (
      <BottomBar>
        {topicTimestamp}
        <Icon
          onClick={() => saveConfig({ transformMarkers: !transformMarkers })}
          tooltip={
            transformMarkers
              ? "Markers are being transformed by webviz based on the camera model. Click to turn it off."
              : `Markers can be transformed by webviz based on the camera model. Click to turn it on.`
          }
          fade
          medium
        >
          <WavesIcon style={{ color: transformMarkers ? colors.orange : colors.textBright }} />
        </Icon>
      </BottomBar>
    );
  };

  const showEmptyState = !imageMessage || (shouldSynchronize && !synchronizedMessages);

  return (
    <Flex col clip>
      {toolbar}
      {/* If rendered, EmptyState will hide the always-present ImageCanvas */}
      {showEmptyState &&
        renderEmptyState(cameraTopic, enabledMarkerTopics, shouldSynchronize, messagesByTopic)}
      {/* Always render the ImageCanvas because it's expensive to unmount and start up. */}
      {imageMessageToRender && (
        <ImageCanvas
          panelHooks={panelHooks}
          topic={cameraTopicFullObject}
          image={imageMessageToRender}
          rawMarkerData={rawMarkerData}
          config={config}
          saveConfig={saveConfig}
          onStartRenderImage={onStartRenderImage}
        />
      )}
      {!showEmptyState && !isDemoMode && renderBottomBar()}
    </Flex>
  );
}

ImageView.panelType = "ImageViewPanel";
ImageView.defaultConfig = (getGlobalHooks() as any).perPanelHooks().ImageView.defaultConfig;

export default Panel<Config>(ImageView as any);
