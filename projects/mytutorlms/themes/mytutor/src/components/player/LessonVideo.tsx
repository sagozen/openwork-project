import { createElement, useEffect, useRef, useState } from "react";
import type {
  DrmType,
  PlaybackDeviceSession,
  PlaybackGrant,
} from "@mytutor/plugin-mytutor-lms/model";
import { LearningError, studentRequest } from "../../lib/student-client";
import type { Translate, UiLocale } from "../../i18n";
import { track } from "../../lib/analytics";
import { detectDrm, deviceLabel } from "./drm-support";
import { loadWistia, startDrmPlayback, type PlayerEngine } from "./engines";

type Phase =
  | { kind: "loading" }
  | { kind: "playing"; grant: PlaybackGrant }
  | { kind: "deviceLimit"; sessions: PlaybackDeviceSession[] }
  | { kind: "error"; message: string };

// The classroom plays one lesson at a time. Each new playback replaces this
// tab's previous session (kept across reloads in sessionStorage), so moving
// between lessons or refreshing never counts as a second screen.
const lastKey = (enrollmentId: string) => `mytutor:playback:${enrollmentId}`;
let lastSession: { enrollmentId: string; id: string } | null = null;
function previousSession(enrollmentId: string): string | null {
  if (lastSession?.enrollmentId === enrollmentId) return lastSession.id;
  try {
    return window.sessionStorage.getItem(lastKey(enrollmentId));
  } catch {
    return null;
  }
}
function rememberSession(enrollmentId: string, id: string) {
  lastSession = { enrollmentId, id };
  try {
    window.sessionStorage.setItem(lastKey(enrollmentId), id);
  } catch {
    // Storage may be unavailable (private mode); memory still covers lesson switches.
  }
}
function endSession(sessionId: string, enrollmentId: string) {
  void studentRequest("playbackEnd", { sessionId }, enrollmentId).catch(
    () => undefined,
  );
}

export default function LessonVideo({
  courseId,
  lessonId,
  enrollmentId,
  title,
  locale,
  t,
  onAccessLost,
}: {
  courseId: string;
  lessonId: string;
  enrollmentId: string;
  title: string;
  locale: UiLocale;
  t: Translate;
  onAccessLost: (message: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [replace, setReplace] = useState<string | null>(null);
  const [markCorner, setMarkCorner] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const onLost = useRef(onAccessLost);
  onLost.current = onAccessLost;

  useEffect(() => {
    let cancelled = false;
    let sessionId: string | null = null;
    // React does not unmount on unload; free the screen when the page goes away.
    const leave = () => {
      if (sessionId) endSession(sessionId, enrollmentId);
    };
    window.addEventListener("pagehide", leave);
    setPhase({ kind: "loading" });
    (async () => {
      let drm: DrmType | null = null;
      try {
        drm = await detectDrm();
        const grant = await studentRequest<PlaybackGrant>(
          "playback",
          {
            courseId,
            lessonId,
            locale,
            drm,
            deviceLabel: deviceLabel(),
            replaceSessionId: replace ?? previousSession(enrollmentId),
          },
          enrollmentId,
        );
        if (cancelled) {
          // The learner already left this lesson; do not hold a screen.
          endSession(grant.sessionId, enrollmentId);
          return;
        }
        sessionId = grant.sessionId;
        rememberSession(enrollmentId, grant.sessionId);
        if (grant.provider === "wistia") await loadWistia(grant.mediaHashedId);
        if (cancelled) return;
        setPhase({ kind: "playing", grant });
        track("video_play_started", { lessonId }, locale);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof LearningError) {
          if (["ACCESS_DENIED", "AUTH_REQUIRED"].includes(cause.code))
            return onLost.current(cause.message);
          if (cause.code === "DEVICE_LIMIT")
            return setPhase({
              kind: "deviceLimit",
              sessions: cause.details?.sessions ?? [],
            });
          track("video_error", { lessonId, code: cause.code }, locale);
          return setPhase({ kind: "error", message: cause.message });
        }
        setPhase({
          kind: "error",
          message: t("video.startFailed"),
        });
      }
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", leave);
      leave();
    };
    // `replace` and `attempt` deliberately restart the request.
  }, [courseId, lessonId, enrollmentId, attempt, replace]);

  // Start the DRM engine once its <video> element is mounted.
  useEffect(() => {
    if (phase.kind !== "playing" || phase.grant.provider !== "doverunner")
      return;
    const element = video.current;
    if (!element) return;
    let engine: PlayerEngine | undefined;
    let stopped = false;
    const grant = phase.grant;
    const drm = (Object.keys(grant.drm) as DrmType[])[0]!;
    const fail = (message: string) => {
      if (!stopped) setPhase({ kind: "error", message });
    };
    startDrmPlayback(element, grant, drm, () => fail(t("video.stopped"))).then(
      (started) => {
        if (stopped) void started.destroy();
        else engine = started;
      },
      (cause: unknown) =>
        fail(
          cause instanceof Error && cause.message === "UNSUPPORTED_DEVICE"
            ? t("video.unsupported")
            : t("video.secureFailed"),
        ),
    );
    return () => {
      stopped = true;
      void engine?.destroy();
    };
  }, [phase]);

  // The visible code is a deterrent; it moves so it cannot be cropped once.
  useEffect(() => {
    if (phase.kind !== "playing") return;
    const timer = window.setInterval(
      () => setMarkCorner((corner) => (corner + 1) % 4),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  if (phase.kind === "loading")
    return (
      <div className="lesson-video lesson-video-state" role="status">
        {t("video.preparing")}
      </div>
    );
  if (phase.kind === "deviceLimit")
    return (
      <div className="lesson-video lesson-video-state" role="alert">
        <p>
          <strong>{t("video.deviceLimit.title")}</strong>{" "}
          {t("video.deviceLimit.body")}
        </p>
        <ul>
          {phase.sessions.map((session) => (
            <li key={session.id}>
              {t("video.deviceLimit.session", {
                device: session.deviceLabel,
                time: new Date(session.issuedAt).toLocaleTimeString(locale, {
                  timeStyle: "short",
                }),
              })}{" "}
              <button
                type="button"
                className="button small"
                onClick={() => setReplace(session.id)}
              >
                {t("video.deviceLimit.watchHere")}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  if (phase.kind === "error")
    return (
      <div
        className="lesson-video lesson-video-state notice error"
        role="alert"
      >
        <p>{phase.message}</p>
        <p>{t("video.stillAvailable")}</p>
        <button
          type="button"
          className="button small"
          onClick={() => {
            setReplace(null);
            setAttempt((value) => value + 1);
          }}
        >
          {t("common.tryAgain")}
        </button>
      </div>
    );

  const { grant } = phase;
  return (
    <div className="lesson-video">
      {grant.provider === "wistia" ? (
        createElement("wistia-player", {
          "media-id": grant.mediaHashedId,
          "aria-label": t("video.label", { title }),
        })
      ) : (
        <video
          ref={video}
          controls
          playsInline
          controlsList="nodownload"
          disablePictureInPicture
          aria-label={t("video.label", { title })}
        />
      )}
      <span
        className={`video-mark video-mark-${markCorner}`}
        aria-hidden="true"
      >
        {grant.visibleMark}
      </span>
    </div>
  );
}
