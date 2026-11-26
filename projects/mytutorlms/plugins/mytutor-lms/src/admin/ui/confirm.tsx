import { createContext, useContext, type ReactNode } from "react";
import { useConfirmDialog, type Confirm } from "../../ui/index.js";

// One dialog for the whole workspace; screens ask through useConfirm().
const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [confirm, dialog] = useConfirmDialog();
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm needs a ConfirmProvider");
  return {
    /** A yes/no question. Destructive ones start with focus on Cancel. */
    ask: async (options: {
      title: string;
      body?: string;
      confirmLabel: string;
      danger?: boolean;
    }) =>
      (await confirm({
        title: options.title,
        body: options.body ? <p>{options.body}</p> : undefined,
        confirmLabel: options.confirmLabel,
        cancelLabel: "Cancel",
        tone: options.danger ? "danger" : "default",
      })) !== null,
    /** A note, required, recorded with the action. */
    note: async (options: {
      title: string;
      body?: string;
      label: string;
      confirmLabel: string;
    }) =>
      (
        await confirm({
          title: options.title,
          body: options.body ? <p>{options.body}</p> : undefined,
          confirmLabel: options.confirmLabel,
          cancelLabel: "Cancel",
          reason: {
            label: options.label,
            minLength: 1,
            error: "Write a short note before continuing.",
          },
        })
      )?.reason ?? null,
    /**
     * Typed confirmation and reason for high-impact actions; the server
     * checks both and records them in the audit log.
     */
    action: async (description: string, phrase: string) => {
      const result = await confirm({
        title: "Confirm this change",
        body: <p>{description}</p>,
        confirmLabel: "Confirm",
        cancelLabel: "Cancel",
        tone: "danger",
        typed: {
          label: `Type ${phrase} to confirm`,
          expected: phrase,
          error: `Type ${phrase} exactly as shown.`,
        },
        reason: {
          label: "Reason",
          hint: "At least 10 characters. Kept in the audit log.",
          minLength: 10,
          maxLength: 500,
          error: "Write a reason of at least 10 characters.",
        },
      });
      return result
        ? { confirmation: result.typed, reason: result.reason }
        : null;
    },
  };
}
