/* Toast dùng chung cho toàn bộ khu vực LIMS (Fluent v9). */
import { useCallback } from "react";
import {
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  useToastController,
} from "@fluentui/react-components";
import { useIsMobile } from "@/hooks/use-mobile";

export const DLP_TOASTER_ID = "dlp-toaster";

export function DlpToaster() {
  // Trên điện thoại phải nâng toast lên trên thanh tab dưới (56px + đệm).
  const isMobile = useIsMobile();
  return (
    <Toaster
      toasterId={DLP_TOASTER_ID}
      position="bottom-end"
      pauseOnHover
      offset={{ vertical: isMobile ? 84 : 16, horizontal: isMobile ? 12 : 16 }}
    />
  );
}

type Intent = "success" | "info" | "warning" | "error";

export function useDlpToast() {
  const { dispatchToast } = useToastController(DLP_TOASTER_ID);

  return useCallback(
    (title: string, body?: string, intent: Intent = "success") => {
      dispatchToast(
        <Toast>
          <ToastTitle>{title}</ToastTitle>
          {body ? <ToastBody>{body}</ToastBody> : null}
        </Toast>,
        { intent, timeout: 3200 },
      );
    },
    [dispatchToast],
  );
}
