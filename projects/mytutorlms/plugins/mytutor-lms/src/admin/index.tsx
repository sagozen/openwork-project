import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginAdminExports } from "emdash";
import { z } from "zod";
import type { CourseRecord } from "../model.js";
import { ToastRegion, showToast } from "../ui/index.js";
import { adminCall, api } from "./api.js";
import { Assignments } from "./assignments.js";
import { CourseEditor } from "./course-editor.js";
import { LiveSessions } from "./live-sessions.js";
import { MediaLibrary } from "./media-library.js";
import { Operations } from "./operations.js";
import { People } from "./people.js";
import { parseRoute, routeHash, type Route } from "./routes.js";
import { Failure, type BlockState } from "./shared.js";
import { Students } from "./students.js";
import { Team } from "./team.js";
import { ConfirmProvider, useConfirm } from "./ui/confirm.js";
import { WorkspaceHome } from "./workspace-home.js";
import "../design/tokens.css";
import "../ui/ui.css";
import "./styles.css";

const NAV: Array<{ route: Route; label: string; permission?: string }> = [
  { route: { view: "courses" }, label: "Courses" },
  { route: { view: "students" }, label: "Students", permission: "roster.read" },
  { route: { view: "grading" }, label: "Grading" },
  { route: { view: "team" }, label: "Team", permission: "staff.manage" },
  {
    route: { view: "site" },
    label: "Site and records",
    permission: "site.settings",
  },
];

function Workspace() {
  const { ask } = useConfirm();
  const [courses, setCourses] = useState<CourseRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.hash),
  );
  // A new course gets its id once per visit to #/courses/new.
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [permissions, setPermissions] = useState<string[]>([]);
  const can = (permission: string) => permissions.includes(permission);
  const block = useRef<BlockState>({ dirty: false, pending: false });
  const heading = useRef<HTMLHeadingElement>(null);
  const currentUrl = useRef(window.location.href);
  const currentState = useRef<unknown>(window.history.state);
  const onBlock = useCallback((state: BlockState) => {
    block.current = state;
  }, []);
  const allowLeave = useCallback(async () => {
    if (block.current.pending) {
      showToast(
        "Please wait for the current operation to finish before leaving.",
        "info",
      );
      return false;
    }
    if (!block.current.dirty) return true;
    const leave = await ask({
      title: "Leave this view?",
      body: "Unsaved changes will be lost. Any invitation link shown here cannot be retrieved later; save or share it first.",
      confirmLabel: "Leave without saving",
      danger: true,
    });
    if (leave) block.current = { dirty: false, pending: false };
    return leave;
  }, [ask]);

  useEffect(() => {
    // Drives which screens are shown; every action is still checked on the server.
    adminCall("me", {}, z.object({ permissions: z.array(z.string()) })).then(
      (me) => setPermissions(me.permissions),
      () => setPermissions([]),
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api.courses(controller.signal).then(
      (records) => {
        if (controller.signal.aborted) return;
        setCourses(records);
        setLoading(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause);
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    function show(url: string) {
      const previous = parseRoute(new URL(currentUrl.current).hash);
      const next = parseRoute(new URL(url).hash);
      currentUrl.current = url;
      currentState.current = window.history.state;
      if (next.view === "editor" && next.id === "new")
        setNewId(crypto.randomUUID());
      setRoute(next);
      // Coming back to a list shows fresh data and puts focus on its heading.
      if (
        previous.view !== next.view &&
        ["home", "courses", "grading"].includes(next.view)
      ) {
        setRefresh((value) => value + 1);
        requestAnimationFrame(() => heading.current?.focus());
      }
    }
    const blocked = () => block.current.dirty || block.current.pending;
    function hashChange() {
      // Guards ran before the hash moved (clicks, go() and popstate below).
      if (window.location.href !== currentUrl.current)
        show(window.location.href);
    }
    function popstate(event: PopStateEvent) {
      if (!blocked()) {
        currentState.current = window.history.state;
        return;
      }
      // Back or Forward, to a workspace screen or another admin page: stay
      // put (keeping this entry's state) until the instructor decides, then
      // replay the move.
      event.stopImmediatePropagation();
      window.history.pushState(currentState.current, "", currentUrl.current);
      void allowLeave().then((leave) => {
        if (leave) window.history.back();
      });
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      if (blocked()) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function guardLinks(event: MouseEvent) {
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !blocked() ||
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.href === window.location.href) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void allowLeave().then((leave) => {
        if (leave) window.location.assign(destination.href);
      });
    }
    window.addEventListener("hashchange", hashChange);
    window.addEventListener("popstate", popstate, true);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("hashchange", hashChange);
      window.removeEventListener("popstate", popstate, true);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [allowLeave]);

  async function go(next: Route) {
    if (await allowLeave()) window.location.hash = routeHash(next);
  }
  const close = () => void go({ view: "home" });
  const courseFor = (id: string) => courses?.find((record) => record.id === id);
  const editorId = route.view === "editor" && route.id === "new" ? newId : null;

  function screen() {
    switch (route.view) {
      case "students":
        return (
          <People
            courses={courses ?? []}
            canGrant={can("entitlement.grant")}
            canManageStudents={can("student.update")}
            onClose={close}
          />
        );
      case "team":
        return <Team courses={courses ?? []} onClose={close} />;
      case "site":
        return <Operations onClose={close} />;
      case "home":
      case "courses":
      case "grading":
        return (
          <WorkspaceHome
            view={route.view}
            courses={courses}
            loading={loading}
            error={error}
            can={can}
            onRefresh={() => setRefresh((value) => value + 1)}
            headingRef={heading}
          />
        );
    }
    if (!courses)
      return error ? (
        <Failure
          error={error}
          retry={() => setRefresh((value) => value + 1)}
          retryLabel="Retry course list"
        />
      ) : (
        <p role="status">Loading your courses…</p>
      );
    if (route.view === "editor") {
      const id = editorId ?? route.id;
      const record = courseFor(id);
      if (!editorId && !record) return <MissingCourse />;
      return (
        <CourseEditor
          key={id}
          id={id}
          record={record}
          onBlock={onBlock}
          onClose={close}
          onSaved={(saved) => {
            setCourses((current) => {
              const records = current ?? [];
              return records.some((item) => item.id === saved.id)
                ? records.map((item) => (item.id === saved.id ? saved : item))
                : [...records, saved];
            });
            // A saved new course gets its own address.
            if (editorId) {
              const url = new URL(window.location.href);
              url.hash = routeHash({ view: "editor", id: saved.id });
              window.history.replaceState(null, "", url);
              currentUrl.current = url.href;
              setRoute({ view: "editor", id: saved.id });
            }
          }}
        />
      );
    }
    const record = courseFor(route.id);
    if (!record) return <MissingCourse />;
    if (route.view === "roster")
      return (
        <Students
          key={record.id}
          course={record}
          onBlock={onBlock}
          onClose={close}
        />
      );
    if (route.view === "live")
      return (
        <LiveSessions
          key={record.id}
          course={record}
          onBlock={onBlock}
          onClose={close}
        />
      );
    if (route.view === "media")
      return (
        <MediaLibrary
          key={record.id}
          course={record}
          onBlock={onBlock}
          onClose={close}
        />
      );
    return (
      <Assignments
        key={record.id}
        course={record}
        onBlock={onBlock}
        onClose={() => void go({ view: "grading" })}
      />
    );
  }

  return (
    <div className="mytutor-admin">
      <header className="mt-header">
        <div>
          <p className="mt-eyebrow">MyTutor · Instructor workspace</p>
          <h1>Good teaching starts here.</h1>
          <p>
            A thoughtful course, a personal invitation, and a clear path for
            every student.
          </p>
        </div>
        <span className="mt-private-label">Private administration</span>
      </header>
      <nav className="mt-workspace-nav" aria-label="Workspace">
        {NAV.filter((item) => !item.permission || can(item.permission)).map(
          (item) => {
            const active =
              item.route.view === route.view ||
              (item.route.view === "courses" &&
                ["home", "editor", "roster", "media", "live"].includes(
                  route.view,
                )) ||
              (item.route.view === "grading" && route.view === "assignments");
            return (
              <a
                key={item.label}
                href={routeHash(item.route)}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </a>
            );
          },
        )}
      </nav>
      {screen()}
      <footer className="mt-footer">
        Built for a personal learning experience. Private invitations, manually
        shared. Video providers and keys live in this plugin's settings.
      </footer>
      <ToastRegion dismissLabel="Dismiss" />
    </div>
  );
}

function MissingCourse() {
  return (
    <section className="mt-panel">
      <h2>This course is not available</h2>
      <p className="mt-muted">
        It may have been deleted, or your role does not include it.
      </p>
      <a className="mt-button" href={routeHash({ view: "home" })}>
        Back to the workspace
      </a>
    </section>
  );
}

function WorkspacePage() {
  return (
    <ConfirmProvider>
      <Workspace />
    </ConfirmProvider>
  );
}

export const pages: PluginAdminExports["pages"] = {
  "/workspace": WorkspacePage,
};
