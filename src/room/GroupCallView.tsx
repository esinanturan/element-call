/*
Copyright 2022-2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type FC,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type MatrixClient } from "matrix-js-sdk/src/client";
import {
  isE2EESupported as isE2EESupportedBrowser,
  Room,
} from "livekit-client";
import { logger } from "matrix-js-sdk/src/logger";
import { type MatrixRTCSession } from "matrix-js-sdk/src/matrixrtc/MatrixRTCSession";
import { JoinRule } from "matrix-js-sdk/src/matrix";
import {
  OfflineIcon,
  WebBrowserIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ErrorBoundary } from "@sentry/react";
import { Button } from "@vector-im/compound-web";

import type { IWidgetApiRequest } from "matrix-widget-api";
import {
  ElementWidgetActions,
  type JoinCallData,
  type WidgetHelpers,
} from "../widget";
import { ErrorPage, FullScreenView } from "../FullScreenView";
import { LobbyView } from "./LobbyView";
import { type MatrixInfo } from "./VideoPreview";
import { CallEndedView } from "./CallEndedView";
import { PosthogAnalytics } from "../analytics/PosthogAnalytics";
import { useProfile } from "../profile/useProfile";
import { findDeviceByName } from "../utils/media";
import { ActiveCall } from "./InCallView";
import { MUTE_PARTICIPANT_COUNT, type MuteStates } from "./MuteStates";
import { useMediaDevices } from "../livekit/MediaDevicesContext";
import { useMatrixRTCSessionMemberships } from "../useMatrixRTCSessionMemberships";
import { enterRTCSession, leaveRTCSession } from "../rtcSessionHelpers";
import { useRoomEncryptionSystem } from "../e2ee/sharedKeyManagement";
import { useRoomAvatar } from "./useRoomAvatar";
import { useRoomName } from "./useRoomName";
import { useJoinRule } from "./useJoinRule";
import { InviteModal } from "./InviteModal";
import { useUrlParams } from "../UrlParams";
import { E2eeType } from "../e2ee/e2eeType";
import { useAudioContext } from "../useAudioContext";
import { callEventAudioSounds } from "./CallEventAudioRenderer";
import { useLatest } from "../useLatest";
import { usePageTitle } from "../usePageTitle";
import { ErrorView } from "../ErrorView";
import {
  ConnectionLostError,
  ElementCallError,
  ErrorCategory,
  ErrorCode,
} from "../utils/errors.ts";
import { ElementCallRichError } from "../RichError.tsx";

declare global {
  interface Window {
    rtcSession?: MatrixRTCSession;
  }
}

interface GroupCallErrorPageProps {
  error: Error | unknown;
  resetError: () => void;
}

interface Props {
  client: MatrixClient;
  isPasswordlessUser: boolean;
  confineToRoom: boolean;
  preload: boolean;
  skipLobby: boolean;
  hideHeader: boolean;
  rtcSession: MatrixRTCSession;
  isJoined: boolean;
  muteStates: MuteStates;
  widget: WidgetHelpers | null;
}

export const GroupCallView: FC<Props> = ({
  client,
  isPasswordlessUser,
  confineToRoom,
  preload,
  skipLobby,
  hideHeader,
  rtcSession,
  isJoined,
  muteStates,
  widget,
}) => {
  const memberships = useMatrixRTCSessionMemberships(rtcSession);
  const leaveSoundContext = useLatest(
    useAudioContext({
      sounds: callEventAudioSounds,
      latencyHint: "interactive",
    }),
  );
  // This should use `useEffectEvent` (only available in experimental versions)
  useEffect(() => {
    if (memberships.length >= MUTE_PARTICIPANT_COUNT)
      muteStates.audio.setEnabled?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.rtcSession = rtcSession;
    return (): void => {
      delete window.rtcSession;
    };
  }, [rtcSession]);

  useEffect(() => {
    // Sanity check the room object
    if (client.getRoom(rtcSession.room.roomId) !== rtcSession.room)
      logger.warn(
        `We've ended up with multiple rooms for the same ID (${rtcSession.room.roomId}). This indicates a bug in the group call loading code, and may lead to incomplete room state.`,
      );
  }, [client, rtcSession.room]);

  const { displayName, avatarUrl } = useProfile(client);
  const roomName = useRoomName(rtcSession.room);
  const roomAvatar = useRoomAvatar(rtcSession.room);
  const { perParticipantE2EE, returnToLobby } = useUrlParams();
  const e2eeSystem = useRoomEncryptionSystem(rtcSession.room.roomId);
  usePageTitle(roomName);

  const matrixInfo = useMemo((): MatrixInfo => {
    return {
      userId: client.getUserId()!,
      displayName: displayName!,
      avatarUrl: avatarUrl!,
      roomId: rtcSession.room.roomId,
      roomName,
      roomAlias: rtcSession.room.getCanonicalAlias(),
      roomAvatar,
      e2eeSystem,
    };
  }, [
    client,
    displayName,
    avatarUrl,
    rtcSession.room,
    roomName,
    roomAvatar,
    e2eeSystem,
  ]);

  // Count each member only once, regardless of how many devices they use
  const participantCount = useMemo(
    () => new Set<string>(memberships.map((m) => m.sender!)).size,
    [memberships],
  );

  const deviceContext = useMediaDevices();
  const latestDevices = useLatest(deviceContext);
  const latestMuteStates = useLatest(muteStates);

  const enterRTCSessionOrError = async (
    rtcSession: MatrixRTCSession,
    perParticipantE2EE: boolean,
  ): Promise<void> => {
    try {
      await enterRTCSession(rtcSession, perParticipantE2EE);
    } catch (e) {
      if (e instanceof ElementCallError) {
        // e.code === ErrorCode.MISSING_LIVE_KIT_SERVICE_URL)
        setEnterRTCError(e);
      } else {
        logger.error(`Unknown Error while entering RTC session`, e);
        const error = new ElementCallError(
          e.message,
          ErrorCode.UNKNOWN_ERROR,
          ErrorCategory.UNKNOWN,
        );
        setEnterRTCError(error);
      }
    }
  };

  useEffect(() => {
    const defaultDeviceSetup = async ({
      audioInput,
      videoInput,
    }: JoinCallData): Promise<void> => {
      // XXX: I think this is broken currently - LiveKit *won't* request
      // permissions and give you device names unless you specify a kind, but
      // here we want all kinds of devices. This needs a fix in livekit-client
      // for the following name-matching logic to do anything useful.
      const devices = await Room.getLocalDevices(undefined, true);

      if (audioInput) {
        const deviceId = findDeviceByName(audioInput, "audioinput", devices);
        if (!deviceId) {
          logger.warn("Unknown audio input: " + audioInput);
          // override the default mute state
          latestMuteStates.current!.audio.setEnabled?.(false);
        } else {
          logger.debug(
            `Found audio input ID ${deviceId} for name ${audioInput}`,
          );
          latestDevices.current!.audioInput.select(deviceId);
        }
      }

      if (videoInput) {
        const deviceId = findDeviceByName(videoInput, "videoinput", devices);
        if (!deviceId) {
          logger.warn("Unknown video input: " + videoInput);
          // override the default mute state
          latestMuteStates.current!.video.setEnabled?.(false);
        } else {
          logger.debug(
            `Found video input ID ${deviceId} for name ${videoInput}`,
          );
          latestDevices.current!.videoInput.select(deviceId);
        }
      }
    };

    if (skipLobby) {
      if (widget) {
        if (preload) {
          // In preload mode without lobby we wait for a join action before entering
          const onJoin = (ev: CustomEvent<IWidgetApiRequest>): void => {
            (async (): Promise<void> => {
              await defaultDeviceSetup(
                ev.detail.data as unknown as JoinCallData,
              );
              await enterRTCSessionOrError(rtcSession, perParticipantE2EE);
              widget.api.transport.reply(ev.detail, {});
            })().catch((e) => {
              logger.error("Error joining RTC session", e);
            });
          };
          widget.lazyActions.on(ElementWidgetActions.JoinCall, onJoin);
          return (): void => {
            widget.lazyActions.off(ElementWidgetActions.JoinCall, onJoin);
          };
        } else {
          // No lobby and no preload: we enter the rtc session right away
          (async (): Promise<void> => {
            await enterRTCSessionOrError(rtcSession, perParticipantE2EE);
          })().catch((e) => {
            logger.error("Error joining RTC session", e);
          });
        }
      } else {
        void enterRTCSessionOrError(rtcSession, perParticipantE2EE);
      }
    }
  }, [
    widget,
    rtcSession,
    preload,
    skipLobby,
    perParticipantE2EE,
    latestDevices,
    latestMuteStates,
  ]);

  const [left, setLeft] = useState(false);
  const [enterRTCError, setEnterRTCError] = useState<ElementCallError | null>(
    null,
  );
  const navigate = useNavigate();

  const onLeave = useCallback(
    (cause: "user" | "error" = "user"): void => {
      const audioPromise = leaveSoundContext.current?.playSound("left");
      // In embedded/widget mode the iFrame will be killed right after the call ended prohibiting the posthog event from getting sent,
      // therefore we want the event to be sent instantly without getting queued/batched.
      const sendInstantly = !!widget;
      setLeft(true);
      // we need to wait until the callEnded event is tracked on posthog.
      // Otherwise the iFrame gets killed before the callEnded event got tracked.
      const posthogRequest = new Promise((resolve) => {
        PosthogAnalytics.instance.eventCallEnded.track(
          rtcSession.room.roomId,
          rtcSession.memberships.length,
          sendInstantly,
          rtcSession,
        );
        window.setTimeout(resolve, 10);
      });

      leaveRTCSession(
        rtcSession,
        cause,
        // Wait for the sound in widget mode (it's not long)
        Promise.all([audioPromise, posthogRequest]),
      )
        // Only sends matrix leave event. The Livekit session will disconnect once the ActiveCall-view unmounts.
        .then(async () => {
          if (
            !isPasswordlessUser &&
            !confineToRoom &&
            !PosthogAnalytics.instance.isEnabled()
          ) {
            await navigate("/");
          }
        })
        .catch((e) => {
          logger.error("Error leaving RTC session", e);
        });
    },
    [
      widget,
      rtcSession,
      isPasswordlessUser,
      confineToRoom,
      leaveSoundContext,
      navigate,
    ],
  );

  useEffect(() => {
    if (widget && isJoined) {
      // set widget to sticky once joined.
      widget.api.setAlwaysOnScreen(true).catch((e) => {
        logger.error("Error calling setAlwaysOnScreen(true)", e);
      });

      const onHangup = (ev: CustomEvent<IWidgetApiRequest>): void => {
        widget.api.transport.reply(ev.detail, {});
        // Only sends matrix leave event. The Livekit session will disconnect once the ActiveCall-view unmounts.
        leaveRTCSession(rtcSession, "user").catch((e) => {
          logger.error("Failed to leave RTC session", e);
        });
      };
      widget.lazyActions.once(ElementWidgetActions.HangupCall, onHangup);
      return (): void => {
        widget.lazyActions.off(ElementWidgetActions.HangupCall, onHangup);
      };
    }
  }, [widget, isJoined, rtcSession]);

  const joinRule = useJoinRule(rtcSession.room);

  const [shareModalOpen, setInviteModalOpen] = useState(false);
  const onDismissInviteModal = useCallback(
    () => setInviteModalOpen(false),
    [setInviteModalOpen],
  );

  const onShareClickFn = useCallback(
    () => setInviteModalOpen(true),
    [setInviteModalOpen],
  );
  const onShareClick = joinRule === JoinRule.Public ? onShareClickFn : null;

  const { t } = useTranslation();

  const errorPage = useMemo(() => {
    function GroupCallErrorPage({
      error,
      resetError,
    }: GroupCallErrorPageProps): ReactElement {
      useEffect(() => {
        if (rtcSession.isJoined()) onLeave("error");
      }, [error]);

      const onReconnect = useCallback(() => {
        setLeft(false);
        resetError();
        enterRTCSessionOrError(rtcSession, perParticipantE2EE).catch((e) => {
          logger.error("Error re-entering RTC session", e);
        });
      }, [resetError]);

      return error instanceof ConnectionLostError ? (
        <FullScreenView>
          <ErrorView
            Icon={OfflineIcon}
            title={t("error.connection_lost")}
            rageshake
          >
            <p>{t("error.connection_lost_description")}</p>
            <Button onClick={onReconnect}>
              {t("call_ended_view.reconnect_button")}
            </Button>
          </ErrorView>
        </FullScreenView>
      ) : (
        <ErrorPage error={error} />
      );
    }
    return GroupCallErrorPage;
  }, [onLeave, rtcSession, perParticipantE2EE, t]);

  if (!isE2EESupportedBrowser() && e2eeSystem.kind !== E2eeType.NONE) {
    // If we have a encryption system but the browser does not support it.
    return (
      <FullScreenView>
        <ErrorView Icon={WebBrowserIcon} title={t("error.e2ee_unsupported")}>
          <p>{t("error.e2ee_unsupported_description")}</p>
        </ErrorView>
      </FullScreenView>
    );
  }

  const shareModal = (
    <InviteModal
      room={rtcSession.room}
      open={shareModalOpen}
      onDismiss={onDismissInviteModal}
    />
  );
  const lobbyView = (
    <>
      {shareModal}
      <LobbyView
        client={client}
        matrixInfo={matrixInfo}
        muteStates={muteStates}
        onEnter={() =>
          void enterRTCSessionOrError(rtcSession, perParticipantE2EE)
        }
        confineToRoom={confineToRoom}
        hideHeader={hideHeader}
        participantCount={participantCount}
        onShareClick={onShareClick}
      />
    </>
  );

  let body: ReactNode;
  if (enterRTCError) {
    // If an ElementCallError was recorded, then create a component that will fail to render and throw
    // an ElementCallRichError error. This will then be handled by the ErrorBoundary component.
    const ErrorComponent = (): ReactNode => {
      throw new ElementCallRichError(enterRTCError);
    };
    body = <ErrorComponent />;
  } else if (isJoined) {
    body = (
      <>
        {shareModal}
        <ActiveCall
          client={client}
          matrixInfo={matrixInfo}
          rtcSession={rtcSession as MatrixRTCSession}
          participantCount={participantCount}
          onLeave={onLeave}
          hideHeader={hideHeader}
          muteStates={muteStates}
          e2eeSystem={e2eeSystem}
          //otelGroupCallMembership={otelGroupCallMembership}
          onShareClick={onShareClick}
        />
      </>
    );
  } else if (left && widget === null) {
    // Left in SPA mode:

    // The call ended view is shown for two reasons: prompting guests to create
    // an account, and prompting users that have opted into analytics to provide
    // feedback. We don't show a feedback prompt to widget users however (at
    // least for now), because we don't yet have designs that would allow widget
    // users to dismiss the feedback prompt and close the call window without
    // submitting anything.
    if (
      isPasswordlessUser ||
      (PosthogAnalytics.instance.isEnabled() && widget === null)
    ) {
      body = (
        <CallEndedView
          endedCallId={rtcSession.room.roomId}
          client={client}
          isPasswordlessUser={isPasswordlessUser}
          confineToRoom={confineToRoom}
        />
      );
    } else {
      // If the user is a regular user, we'll have sent them back to the homepage,
      // so just sit here & do nothing: otherwise we would (briefly) mount the
      // LobbyView again which would open capture devices again.
      body = null;
    }
  } else if (left && widget !== null) {
    // Left in widget mode:
    if (!returnToLobby) {
      body = null;
    }
  } else if (preload || skipLobby) {
    body = null;
  } else {
    body = lobbyView;
  }

  return <ErrorBoundary fallback={errorPage}>{body}</ErrorBoundary>;
};
