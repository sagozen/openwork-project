import { useEffect, useRef } from "react";

/**
 * Protects unsent work while `active`: closing the tab shows the browser's
 * own prompt (the one native prompt we keep), and following a link first asks
 * `confirmLeave`, then navigates if the student agrees.
 *
 * Returns `allowLeaving()`, which other leave paths (sign out, switching
 * lessons) await before continuing.
 */
export function useUnsavedChangesGuard(
  active: boolean,
  confirmLeave: () => Promise<boolean>,
): { allowLeaving: () => Promise<boolean>; markLeaving: () => void } {
  const leaving = useRef(false);
  const ask = useRef(confirmLeave);
  ask.current = confirmLeave;
  useEffect(() => {
    if (!active) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function followLink(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const destination = new URL(link.href, window.location.href);
      if (!["http:", "https:"].includes(destination.protocol)) return;
      if (
        destination.origin === window.location.origin &&
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void ask.current().then((leave) => {
        if (!leave) return;
        leaving.current = true;
        window.location.assign(destination.href);
      });
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [active]);
  return {
    allowLeaving: async () => {
      if (!active) return true;
      const leave = await ask.current();
      if (leave) leaving.current = true;
      return leave;
    },
    markLeaving: () => {
      leaving.current = true;
    },
  };
}
