/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only
Please see LICENSE in the repository root for full details.
*/

import { type FC, useState } from "react";
import { useTranslation } from "react-i18next";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { Root as Form } from "@vector-im/compound-web";

import { Modal } from "../Modal";
import styles from "./SettingsModal.module.css";
import { type Tab, TabContainer } from "../tabs/Tabs";
import { ProfileSettingsTab } from "./ProfileSettingsTab";
import { FeedbackSettingsTab } from "./FeedbackSettingsTab";
import {
  useMediaDevices,
  useMediaDeviceNames,
} from "../livekit/MediaDevicesContext";
import { widget } from "../widget";
import {
  useSetting,
  soundEffectVolumeSetting,
  developerMode,
} from "./settings";
import { isFirefox } from "../Platform";
import { PreferencesSettingsTab } from "./PreferencesSettingsTab";
import { Slider } from "../Slider";
import { DeviceSelection } from "./DeviceSelection";
import { DeveloperSettingsTab } from "./DeveloperSettingsTab";

type SettingsTab =
  | "audio"
  | "video"
  | "profile"
  | "preferences"
  | "feedback"
  | "more"
  | "developer";

interface Props {
  open: boolean;
  onDismiss: () => void;
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  client: MatrixClient;
  roomId?: string;
}

export const defaultSettingsTab: SettingsTab = "audio";

export const SettingsModal: FC<Props> = ({
  open,
  onDismiss,
  tab,
  onTabChange,
  client,
  roomId,
}) => {
  const { t } = useTranslation();

  const devices = useMediaDevices();
  useMediaDeviceNames(devices, open);
  const [soundVolume, setSoundVolume] = useSetting(soundEffectVolumeSetting);
  const [soundVolumeRaw, setSoundVolumeRaw] = useState(soundVolume);

  const [showDeveloperSettingsTab] = useSetting(developerMode);

  const audioTab: Tab<SettingsTab> = {
    key: "audio",
    name: t("common.audio"),
    content: (
      <>
        <Form>
          <DeviceSelection
            devices={devices.audioInput}
            caption={t("common.microphone")}
          />
          {!isFirefox() && (
            <DeviceSelection
              devices={devices.audioOutput}
              caption={t("settings.speaker_device_selection_label")}
            />
          )}
          <div className={styles.volumeSlider}>
            <label>{t("settings.audio_tab.effect_volume_label")}</label>
            <p>{t("settings.audio_tab.effect_volume_description")}</p>
            <Slider
              label={t("video_tile.volume")}
              value={soundVolumeRaw}
              onValueChange={setSoundVolumeRaw}
              onValueCommit={setSoundVolume}
              min={0}
              max={1}
              step={0.01}
            />
          </div>
        </Form>
      </>
    ),
  };

  const videoTab: Tab<SettingsTab> = {
    key: "video",
    name: t("common.video"),
    content: (
      <Form>
        <DeviceSelection
          devices={devices.videoInput}
          caption={t("common.camera")}
        />
      </Form>
    ),
  };

  const preferencesTab: Tab<SettingsTab> = {
    key: "preferences",
    name: t("common.preferences"),
    content: <PreferencesSettingsTab />,
  };

  const profileTab: Tab<SettingsTab> = {
    key: "profile",
    name: t("common.profile"),
    content: <ProfileSettingsTab client={client} />,
  };

  const feedbackTab: Tab<SettingsTab> = {
    key: "feedback",
    name: t("settings.feedback_tab_title"),
    content: <FeedbackSettingsTab roomId={roomId} />,
  };

  const developerTab: Tab<SettingsTab> = {
    key: "developer",
    name: t("settings.developer_tab_title"),
    content: <DeveloperSettingsTab client={client} />,
  };

  const tabs = [audioTab, videoTab];
  if (widget === null) tabs.push(profileTab);
  tabs.push(preferencesTab, feedbackTab);
  if (showDeveloperSettingsTab) tabs.push(developerTab);

  return (
    <Modal
      title={t("common.settings")}
      className={styles.settingsModal}
      open={open}
      onDismiss={onDismiss}
      tabbed
    >
      <TabContainer
        label={t("common.settings")}
        tab={tab}
        onTabChange={onTabChange}
        tabs={tabs}
      />
    </Modal>
  );
};
