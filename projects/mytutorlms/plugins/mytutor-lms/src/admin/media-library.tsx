import { useCallback, useEffect, useRef, useState } from "react";
import { without } from "../object.js";
import type { FormEvent } from "react";
import type {
  CourseRecord,
  Locale,
  MediaAsset,
  MediaAssetInput,
  MediaLibrary as Library,
  VideoProvider,
} from "../model.js";
import { api, dateLabel, isConflict, newMediaAssetId } from "./api.js";
import { TextField } from "./course-editor.js";
import { Failure, useBlock } from "./shared.js";
import type { OnBlock } from "./shared.js";
import { useConfirm } from "./ui/confirm.js";

const providerLabels: Record<VideoProvider, string> = {
  doverunner: "DoveRunner · DRM protected",
  wistia: "Wistia · not DRM",
};
const stateLabels: Record<MediaAsset["state"], string> = {
  draft: "Draft",
  verified: "Verified on a device",
  published: "Live for students",
  retired: "Retired",
};
const localeLabels: Record<Locale, string> = {
  vi: "Vietnamese",
  en: "English",
  es: "Spanish",
};
interface Draft extends MediaAssetInput {
  id: string;
  revision: string | null;
}

function emptyDraft(courseId: string, lessonId: string): Draft {
  return {
    id: newMediaAssetId(),
    revision: null,
    courseId,
    lessonId,
    locale: "vi",
    role: "original",
    provider: "doverunner",
    contentId: "",
    dashUrl: "",
    hlsUrl: "",
    wistiaMediaHashedId: "",
    durationSeconds: 0,
  };
}
function draftFrom(asset: MediaAsset): Draft {
  return {
    id: asset.id,
    revision: asset.revision,
    courseId: asset.courseId,
    lessonId: asset.lessonId,
    locale: asset.locale,
    role: asset.role,
    provider: asset.provider,
    contentId: asset.contentId,
    dashUrl: asset.routes.primary.manifests.dash ?? "",
    hlsUrl: asset.routes.primary.manifests.hls ?? "",
    wistiaMediaHashedId: asset.wistia?.mediaHashedId ?? "",
    durationSeconds: asset.durationSeconds,
  };
}
/** Fields that do not belong to the chosen provider are cleared before saving. */
function forProvider(draft: Draft): MediaAssetInput {
  const value: MediaAssetInput = without(draft, "id", "revision");
  return value.provider === "wistia"
    ? { ...value, contentId: "", dashUrl: "", hlsUrl: "" }
    : value;
}

function Status({ library }: { library: Library }) {
  const drm = library.protectedVideo;
  return (
    <div className="mt-video-status" role="group" aria-label="Video playback">
      <p>
        <strong>DoveRunner secure video:</strong>{" "}
        {drm.enabled
          ? "On"
          : drm.configured
            ? "Off (turn on in plugin settings)"
            : "Not configured (add site ID and keys in plugin settings)"}
      </p>
      <p>
        <strong>Wistia playback:</strong>{" "}
        {library.wistiaPlayback.enabled
          ? "Allowed for enrolled students. Not copy-protected."
          : "Off (allow it in plugin settings)"}
      </p>
      <p>
        <strong>Video delivery:</strong>{" "}
        {library.route.active === "paused"
          ? `Paused${library.route.reason ? ` — ${library.route.reason}` : ""}`
          : "Live"}
      </p>
    </div>
  );
}

export function MediaLibrary({
  course,
  onClose,
  onBlock,
}: {
  course: CourseRecord;
  onClose: () => void;
  onBlock: OnBlock;
}) {
  const { ask, note } = useConfirm();
  const discard = () =>
    ask({
      title: "Discard the unsaved video details?",
      confirmLabel: "Discard",
      danger: true,
    });
  const [library, setLibrary] = useState<Library | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  useBlock(dirty, pending, onBlock);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const latest = await api.mediaLibrary(course.id, signal);
        if (!signal?.aborted) setLibrary(latest);
      } catch (cause) {
        if (!signal?.aborted) setLoadError(cause);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [course.id],
  );
  useEffect(() => {
    heading.current?.focus();
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError(null);
    setNotice("");
    try {
      await action();
      setNotice(success);
      await load();
    } catch (cause) {
      setActionError(cause);
      if (isConflict(cause)) await load();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function edit(next: Draft) {
    if (dirty && !(await discard())) return;
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setActionError(null);
    setNotice("");
    requestAnimationFrame(() => formHeading.current?.focus());
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const current = draft;
    void run(async () => {
      await api.saveMediaAsset(
        current.id,
        current.revision,
        forProvider(current),
      );
      setDraft(null);
      setBaseline("");
    }, "Video saved as a draft. Play it on a real device, then mark it verified.");
  }

  async function transition(asset: MediaAsset, to: MediaAsset["state"]) {
    const prompts: Partial<
      Record<
        MediaAsset["state"],
        { title: string; body: string; confirmLabel: string; danger?: boolean }
      >
    > = {
      verified: {
        title: "Mark this video verified?",
        body: "Confirm you played it to the end on a real phone or computer using the same browser students will use.",
        confirmLabel: "Mark verified",
      },
      published: {
        title: "Publish this video to students?",
        body: "It replaces the current live video for this lesson and language.",
        confirmLabel: "Publish video",
      },
      retired: {
        title: "Retire this video?",
        body: "Students will no longer be able to play it.",
        confirmLabel: "Retire video",
        danger: true,
      },
    };
    const prompt = prompts[to];
    if (prompt && !(await ask(prompt))) return;
    void run(
      () => api.transitionMediaAsset(asset, to, ""),
      `Video is now: ${stateLabels[to]}.`,
    );
  }

  async function toggleDelivery() {
    if (!library) return;
    const pause = library.route.active !== "paused";
    const reason = await note(
      pause
        ? {
            title: "Pause all video playback?",
            body: "Students will see a maintenance notice until you resume.",
            label: "Why are you pausing playback?",
            confirmLabel: "Pause playback",
          }
        : {
            title: "Resume video playback?",
            label: "Note for resuming playback",
            confirmLabel: "Resume playback",
          },
    );
    if (!reason) return;
    void run(
      () => api.setMediaRoute(pause ? "paused" : "primary", reason.trim()),
      pause ? "Video playback paused." : "Video playback resumed.",
    );
  }

  const disabled = loading || pending || Boolean(loadError);
  const lessons = course.value.lessons;

  return (
    <section className="mt-panel" aria-labelledby="mt-media-heading">
      <div className="mt-section-heading">
        <div>
          <p className="mt-eyebrow">
            {course.value.title || "Untitled course"}
          </p>
          <h2 id="mt-media-heading" ref={heading} tabIndex={-1}>
            Lesson videos
          </h2>
          <p className="mt-muted">
            Choose DoveRunner for DRM-protected video, or Wistia for simpler
            playback that only enrolled students can open but that is not
            copy-protected.
          </p>
        </div>
        <div className="mt-actions">
          <button type="button" disabled={pending} onClick={onClose}>
            Back to courses
          </button>
          <button type="button" disabled={disabled} onClick={() => void load()}>
            Refresh
          </button>
          {library && (
            <button
              type="button"
              className={
                library.route.active === "paused" ? "mt-primary" : "mt-danger"
              }
              disabled={disabled}
              onClick={toggleDelivery}
            >
              {library.route.active === "paused"
                ? "Resume video playback"
                : "Pause all video playback"}
            </button>
          )}
        </div>
      </div>
      {loading && <p role="status">Loading lesson videos…</p>}
      <Failure error={loadError} retry={() => void load()} retryLabel="Retry" />
      <Failure error={actionError} />
      {notice && (
        <p className="mt-notice" role="status">
          {notice}
        </p>
      )}
      {library && <Status library={library} />}
      {library && lessons.length === 0 && (
        <div className="mt-empty">
          <h3>Add lessons first.</h3>
          <p>Videos are attached to lessons. Edit the course to add one.</p>
        </div>
      )}
      {library &&
        lessons.map((lesson, index) => {
          const assets = library.assets.filter(
            (asset) => asset.lessonId === lesson.id,
          );
          return (
            <article key={lesson.id} className="mt-media-lesson">
              <div className="mt-card-heading">
                <h3>
                  {String(index + 1).padStart(2, "0")} ·{" "}
                  {lesson.title || "Untitled lesson"}
                </h3>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => edit(emptyDraft(course.id, lesson.id))}
                  aria-label={`Add a video to ${lesson.title || "this lesson"}`}
                >
                  Add video
                </button>
              </div>
              {assets.length === 0 ? (
                <p className="mt-muted">No video yet.</p>
              ) : (
                <ul className="mt-media-list">
                  {assets.map((asset) => (
                    <li key={asset.id}>
                      <div>
                        <span
                          className={`mt-badge ${asset.state === "published" ? "mt-badge-active" : ""}`}
                        >
                          {stateLabels[asset.state]}
                        </span>{" "}
                        <strong>{providerLabels[asset.provider]}</strong>
                        <p className="mt-muted">
                          {localeLabels[asset.locale]} ·{" "}
                          {asset.role === "dub" ? "Dub" : "Original"} · version{" "}
                          {asset.mediaRevision}
                          {asset.provider === "doverunner" &&
                            ` · content ID ${asset.contentId}`}
                          {asset.wistia &&
                            ` · Wistia ${asset.wistia.mediaHashedId}${asset.provider === "doverunner" ? " (production source)" : ""}`}
                          {asset.routes.primary.smokeTestedAt &&
                            ` · verified ${dateLabel(asset.routes.primary.smokeTestedAt)}`}
                        </p>
                        {asset.provider === "wistia" && (
                          <p className="mt-warning">
                            Not copy-protected: anyone given the Wistia media ID
                            can play it. Use DoveRunner for paid content.
                          </p>
                        )}
                      </div>
                      <div className="mt-actions">
                        {asset.state !== "published" && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => edit(draftFrom(asset))}
                          >
                            Edit
                          </button>
                        )}
                        {asset.state === "draft" && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => transition(asset, "verified")}
                          >
                            Mark verified
                          </button>
                        )}
                        {asset.state === "verified" && (
                          <button
                            type="button"
                            className="mt-primary"
                            disabled={disabled}
                            onClick={() => transition(asset, "published")}
                          >
                            Publish to students
                          </button>
                        )}
                        {asset.state !== "retired" && (
                          <button
                            type="button"
                            className="mt-danger"
                            disabled={disabled}
                            onClick={() => transition(asset, "retired")}
                          >
                            Retire
                          </button>
                        )}
                        {asset.state === "retired" && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => transition(asset, "draft")}
                          >
                            Restore as draft
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {draft?.lessonId === lesson.id && (
                <form className="mt-media-form" onSubmit={save} noValidate>
                  <h4 ref={formHeading} tabIndex={-1}>
                    {draft.revision ? "Edit video" : "New video"}
                  </h4>
                  <fieldset className="mt-field">
                    <legend>Playback provider</legend>
                    {(["doverunner", "wistia"] as const).map((provider) => (
                      <label key={provider}>
                        <input
                          type="radio"
                          name="mt-provider"
                          value={provider}
                          checked={draft.provider === provider}
                          onChange={() => setDraft({ ...draft, provider })}
                        />{" "}
                        {providerLabels[provider]}
                      </label>
                    ))}
                  </fieldset>
                  <div className="mt-grid">
                    <div className="mt-field">
                      <label htmlFor="mt-media-locale">Language</label>
                      <select
                        id="mt-media-locale"
                        value={draft.locale}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            locale: event.target.value as Locale,
                          })
                        }
                      >
                        {(Object.keys(localeLabels) as Locale[]).map(
                          (locale) => (
                            <option key={locale} value={locale}>
                              {localeLabels[locale]}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="mt-field">
                      <label htmlFor="mt-media-role">Version</label>
                      <select
                        id="mt-media-role"
                        value={draft.role}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            role: event.target.value as Draft["role"],
                          })
                        }
                      >
                        <option value="original">Original recording</option>
                        <option value="dub">Dubbed version</option>
                      </select>
                    </div>
                  </div>
                  {draft.provider === "doverunner" ? (
                    <>
                      <TextField
                        id="media-content-id"
                        label="DoveRunner content ID"
                        value={draft.contentId}
                        onChange={(contentId) =>
                          setDraft({ ...draft, contentId })
                        }
                        maxLength={200}
                        hint="The CID used when the video was packaged. Letters, numbers, - and _ only."
                      />
                      <TextField
                        id="media-dash"
                        label="DASH manifest URL (.mpd)"
                        value={draft.dashUrl}
                        onChange={(dashUrl) => setDraft({ ...draft, dashUrl })}
                        maxLength={2048}
                        hint="For Chrome, Edge, Firefox and Android (Widevine/PlayReady)."
                      />
                      <TextField
                        id="media-hls"
                        label="HLS manifest URL (.m3u8)"
                        value={draft.hlsUrl}
                        onChange={(hlsUrl) => setDraft({ ...draft, hlsUrl })}
                        maxLength={2048}
                        hint="For Safari and every iPhone/iPad browser (FairPlay). Without it, Apple devices cannot play."
                      />
                      <TextField
                        id="media-wistia-source"
                        label="Wistia production media ID (optional)"
                        value={draft.wistiaMediaHashedId}
                        onChange={(wistiaMediaHashedId) =>
                          setDraft({ ...draft, wistiaMediaHashedId })
                        }
                        maxLength={32}
                        hint="Where this recording and its dubs are produced. Never shown to students."
                      />
                    </>
                  ) : (
                    <TextField
                      id="media-wistia"
                      label="Wistia media ID"
                      value={draft.wistiaMediaHashedId}
                      onChange={(wistiaMediaHashedId) =>
                        setDraft({ ...draft, wistiaMediaHashedId })
                      }
                      maxLength={32}
                      hint="The ID at the end of the Wistia media URL, for example …/medias/abc123xyz9. Set the video to private in Wistia and turn on domain restrictions for this site."
                    />
                  )}
                  <div className="mt-field">
                    <label htmlFor="mt-media-duration">Length (seconds)</label>
                    <input
                      id="mt-media-duration"
                      type="number"
                      min={0}
                      max={86400}
                      step={1}
                      value={draft.durationSeconds}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          durationSeconds: Math.max(
                            0,
                            Math.trunc(Number(event.target.value) || 0),
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="mt-actions">
                    <button
                      type="submit"
                      className="mt-primary"
                      disabled={pending}
                    >
                      Save draft
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={async () => {
                        if (dirty && !(await discard())) return;
                        setDraft(null);
                        setBaseline("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </article>
          );
        })}
    </section>
  );
}
