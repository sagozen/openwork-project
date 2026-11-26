/** A link attached to a lesson: a web page or a downloadable file. */
export interface LessonResource {
  label: string;
  url: string;
}
export interface Lesson {
  id: string;
  title: string;
  module: string;
  durationMinutes: number;
  body: string;
  videoUrl: string;
  /** The original single resource; shown before `resources`. */
  resourceUrl: string;
  resourceLabel: string;
  /** Additional resources (0.4). Absent means none. */
  resources?: LessonResource[];
}
/**
 * `invite`: access only through invitations and grants.
 * `open`: any signed-in student can start the published course for free.
 */
export type CourseAccess = "invite" | "open";
export interface Course {
  title: string;
  summary: string;
  description: string;
  instructor: string;
  status: "draft" | "published";
  lessons: Lesson[];
  /** Absent means `invite`. */
  access?: CourseAccess;
}
export interface CourseRecord {
  id: string;
  revision: string;
  value: Course;
}
export interface CourseSummary {
  id: string;
  title: string;
  summary: string;
  description: string;
  instructor: string;
  lessonCount: number;
  durationMinutes: number;
  curriculum: {
    id: string;
    title: string;
    module: string;
    durationMinutes: number;
  }[];
  access?: CourseAccess;
  /** Titles and times only; never join links or passcodes. */
  upcomingSessions?: PublicLiveSession[];
}

// ---- Live sessions (0.4) ----

export interface PublicLiveSession {
  id: string;
  title: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  durationMinutes: number;
}
/** What a student with access to the course sees. */
export interface StudentLiveSession extends PublicLiveSession {
  joinUrl: string;
  passcode: string;
  notes: string;
}
export interface LiveSession extends StudentLiveSession {
  courseId: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
}
export interface LiveSessionInput {
  courseId: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  joinUrl: string;
  passcode: string;
  notes: string;
}
export interface StudentView {
  id: string;
  courseId: string;
  name: string;
  email: string;
  active: boolean;
  invitedAt: string;
  completedLessonIds: string[];
  lastActiveAt: string | null;
}
export interface SubmissionRecord {
  id: string;
  revision: string;
  courseId: string;
  lessonId: string;
  kind: "text" | "url";
  content: string;
  status: "submitted" | "needs_revision" | "accepted";
  attempt: number;
  submittedAt: string;
  feedback: string;
  reviewedAt: string | null;
}
export interface InstructorSubmission extends SubmissionRecord {
  lessonTitle: string;
  student: { id: string; name: string; email: string; active: boolean };
}
export interface LearningState {
  enrollmentId: string;
  student: { name: string; email: string };
  course: CourseRecord;
  completedLessonIds: string[];
  submissions: SubmissionRecord[];
  /** Lessons with a published lesson video; never asset IDs, media IDs or URLs. */
  videoLessonIds: string[];
  /** Upcoming, in-progress and recently ended live sessions (0.4). */
  liveSessions?: StudentLiveSession[];
}

export type Locale = "vi" | "en" | "es";
export type DrmType = "widevine" | "playready" | "fairplay";
/**
 * `doverunner`: Multi-DRM, per-session license token (protected).
 * `wistia`: Wistia player, gated by enrollment only (access-controlled, not DRM).
 */
export type VideoProvider = "doverunner" | "wistia";
export interface RouteReadiness {
  packageRef: string | null;
  /** DASH (Widevine/PlayReady) and HLS (FairPlay) manifests packaged with the asset's content ID. */
  manifests: { dash: string | null; hls: string | null };
  smokeTestedAt: string | null;
  captionsVerified: boolean;
  status: "pending" | "ready" | "failed";
}
/** One asset = one lesson x one locale x one media revision. */
export interface MediaAsset {
  id: string;
  revision: string;
  courseId: string;
  lessonId: string;
  locale: Locale;
  mediaRevision: number;
  provider: VideoProvider;
  /** DoveRunner packaging content ID; "" for Wistia playback assets. */
  contentId: string;
  role: "original" | "dub";
  /** Wistia media: the playback source for `wistia`, the production/dub source for `doverunner`. */
  wistia: { mediaHashedId: string; localizationId: string | null } | null;
  durationSeconds: number;
  state: "draft" | "verified" | "published" | "retired";
  routes: { primary: RouteReadiness; backup: RouteReadiness };
  securityPolicyVersion: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}
export interface MediaAssetInput {
  courseId: string;
  lessonId: string;
  locale: Locale;
  role: "original" | "dub";
  provider: VideoProvider;
  contentId: string;
  dashUrl: string;
  hlsUrl: string;
  wistiaMediaHashedId: string;
  durationSeconds: number;
}
export interface MediaRouteState {
  active: "primary" | "backup" | "paused";
  reason: string;
  changedAt: string | null;
}
export interface MediaLibrary {
  assets: MediaAsset[];
  route: MediaRouteState;
  protectedVideo: { enabled: boolean; configured: boolean };
  wistiaPlayback: { enabled: boolean };
}
export interface PlaybackDeviceSession {
  id: string;
  deviceLabel: string;
  issuedAt: string;
}
interface PlaybackGrantBase {
  sessionId: string;
  audioLocales: Locale[];
  expiresAt: string;
  visibleMark: string;
}
export interface WistiaPlaybackGrant extends PlaybackGrantBase {
  provider: "wistia";
  mediaHashedId: string;
}
export type PlaybackGrant = DrmPlaybackGrant | WistiaPlaybackGrant;
export interface DrmPlaybackGrant extends PlaybackGrantBase {
  provider: "doverunner";
  route: "primary";
  manifestUrl: string;
  drm: Partial<
    Record<
      DrmType,
      { licenseUrl: string; token: string; certificateUrl?: string }
    >
  >;
  licenseHeader: string;
}
export interface ResultError {
  code: string;
  message: string;
  details?: { sessions?: PlaybackDeviceSession[] };
}
export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ResultError };

// ---- Student accounts, entitlements and staff (0.3) ----

export type StaffRole = "owner" | "instructor" | "assistant";
export interface ActorRef {
  type: StaffRole | "student" | "system" | "ai";
  id: string;
  label: string;
}
export interface SiteSettings {
  siteId: string;
  accentColor: string;
  locales: Locale[];
  defaultLocale: Locale;
  supportEmail: string;
  legal: { termsUrl: string; privacyUrl: string };
  emailFrom: { name: string; address: string; replyTo: string };
  selfSignup: boolean;
  instructorsMayGrant: boolean;
  passkeysEnabled: boolean;
  dailySignInEmailCap: number;
  features: Record<string, boolean>;
}
export interface PublicSite {
  name: string;
  url: string;
  accentColor: string;
  locales: Locale[];
  defaultLocale: Locale;
  supportEmail: string;
  legal: { termsUrl: string; privacyUrl: string };
  selfSignup: boolean;
  passkeysEnabled: boolean;
}
export interface StudentProfile {
  id: string;
  email: string;
  name: string;
  locale: Locale;
  emailVerified: boolean;
  createdAt: string;
}
export type AccessReason =
  | "ok"
  | "student_disabled"
  | "course_unavailable"
  | "no_entitlement"
  | "not_started"
  | "ended"
  | "revoked"
  | "lesson_not_found"
  | "not_released"
  | "lesson_locked";
export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason;
  entitlementId: string | null;
  expiresAt: string | null;
  opensAt: string | null;
}
export type EntitlementSource = "invite" | "sepay" | "whop" | "manual" | "comp";
export interface EntitlementView {
  id: string;
  studentId: string;
  courseId: string;
  source: EntitlementSource;
  sourceRef: string;
  startsAt: string;
  expiresAt: string | null;
  status: "active" | "revoked";
  grantedBy: ActorRef;
  grantedAt: string;
  revokedAt: string | null;
  revokeReason: string;
}
export interface DashboardCourse {
  courseId: string;
  enrollmentId: string;
  title: string;
  summary: string;
  instructor: string;
  lessonCount: number;
  completedCount: number;
  nextLessonId: string | null;
  lastActiveAt: string | null;
  access: {
    status: "active" | "ending_soon" | "ended" | "revoked";
    expiresAt: string | null;
  };
}
/** A published open course the student has not started yet. */
export interface OpenCourseCard {
  courseId: string;
  title: string;
  summary: string;
  instructor: string;
  lessonCount: number;
}
export interface Dashboard {
  student: StudentProfile;
  courses: DashboardCourse[];
  upgradeAvailable: false;
  /** Open courses the student can start (0.4). */
  openCourses?: OpenCourseCard[];
}
export interface AuditEventView {
  id: string;
  at: string;
  actor: ActorRef;
  action: string;
  subject: { type: string; id: string };
  before: unknown;
  after: unknown;
  reason: string;
}
export interface StaffView {
  userId: string;
  displayName: string;
  email: string;
  role: StaffRole;
  courseIds: string[] | "all";
  active: boolean;
}
export interface SignedIn {
  sessionToken: string;
  expiresAt: string;
  student: StudentProfile;
}
