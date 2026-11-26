import { useEffect, useRef } from "react";
import { InlineAlert } from "../ui/index.js";
import { errorMessage } from "./api.js";

export interface BlockState {
  dirty: boolean;
  pending: boolean;
}
export type OnBlock = (state: BlockState) => void;

export function Failure({
  error,
  retry,
  retryLabel = "Retry",
}: {
  error: unknown;
  retry?: () => void;
  retryLabel?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) box.current?.focus();
  }, [error]);
  if (!error) return null;
  return (
    <div className="mt-failure" ref={box} tabIndex={-1}>
      <InlineAlert
        tone="danger"
        action={
          retry && (
            <button type="button" onClick={retry}>
              {retryLabel}
            </button>
          )
        }
      >
        <p>{errorMessage(error)}</p>
      </InlineAlert>
    </div>
  );
}

export function useBlock(dirty: boolean, pending: boolean, onBlock: OnBlock) {
  useEffect(() => {
    onBlock({ dirty, pending });
  }, [dirty, pending, onBlock]);
  useEffect(() => () => onBlock({ dirty: false, pending: false }), [onBlock]);
}
