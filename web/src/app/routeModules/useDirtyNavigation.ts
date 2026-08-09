import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function useDirtyNavigation(projectId: string | null, confirmation: string) {
  const location = useLocation();
  const navigate = useNavigate();
  const acceptedHistoryIndexRef = useRef<number | null>(
    typeof window.history.state?.idx === "number" ? window.history.state.idx : null,
  );
  const restoringHistoryRef = useRef(false);
  const [dirty, setDirty] = useState(false);

  const confirmNavigation = useCallback(
    () => !dirty || window.confirm(confirmation),
    [confirmation, dirty],
  );

  useEffect(() => setDirty(false), [projectId]);

  useEffect(() => {
    if (typeof window.history.state?.idx === "number") {
      acceptedHistoryIndexRef.current = window.history.state.idx;
    }
  }, [location.key]);

  useLayoutEffect(() => {
    if (!dirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handlePopState = (event: PopStateEvent) => {
      const nextIndex = typeof event.state?.idx === "number" ? event.state.idx : null;
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        acceptedHistoryIndexRef.current = nextIndex;
        return;
      }
      if (window.confirm(confirmation)) {
        acceptedHistoryIndexRef.current = nextIndex;
        return;
      }

      event.stopImmediatePropagation();
      const currentIndex = acceptedHistoryIndexRef.current;
      if (currentIndex !== null && nextIndex !== null && currentIndex !== nextIndex) {
        restoringHistoryRef.current = true;
        window.history.go(currentIndex - nextIndex);
        return;
      }
      navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState, true);
    };
  }, [confirmation, dirty, location.hash, location.pathname, location.search, navigate]);

  return {
    confirmNavigation,
    onDirtyChange: setDirty,
  };
}
