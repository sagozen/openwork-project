import { useEffect, useRef, useState } from "react";
import { useClerk } from "@clerk/tanstack-react-start";
import { isRestrictedCode, RESTRICTED_MESSAGE_VI } from "./clerk-errors";

/**
 * Phát hiện email chưa được mời bị Clerk từ chối ở chế độ Restricted.
 *
 * Luồng thật (đã xác minh trên production, clerk-js 6.26.0):
 * Clerk API từ chối ngay ở bước xác thực OAuth, trả về
 *   signIn.status = "needs_identifier"
 *   signIn.firstFactorVerification.status = "verified"
 *   signIn.firstFactorVerification.error.code = "sign_up_mode_restricted"
 * và KHÔNG tạo signUp nào cả.
 *
 * Với state đó, `_handleRedirectCallback` của clerk-js không khớp nhánh xử lý
 * nào (không transferable, không user_locked, không needs_first_factor…) nên rơi
 * xuống `return navigateToSignIn()` ở cuối hàm - điều hướng im lặng, không ném
 * lỗi, không hiện thông báo. <SignIn/> vẫn kẹt ở bước SSO callback nên người
 * dùng chỉ thấy spinner; F5 mới mount lại và đọc được lỗi đã lưu.
 *
 * Ta đọc thẳng lỗi đó từ client resource để (1) hiện thông báo tiếng Việt ngay
 * và (2) ép <SignIn/> mount lại để thoát khỏi spinner.
 */
export function useRestrictedSignInError(): { message: string | null; resetKey: number } {
  const clerk = useClerk();
  const [message, setMessage] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  // Chỉ remount <SignIn/> đúng một lần cho mỗi lần lỗi xuất hiện, tránh lặp vô hạn.
  const alreadyReset = useRef(false);

  useEffect(() => {
    const check = () => {
      const code = clerk.client?.signIn?.firstFactorVerification?.error?.code;
      if (isRestrictedCode(code)) {
        setMessage(RESTRICTED_MESSAGE_VI);
        if (!alreadyReset.current) {
          alreadyReset.current = true;
          setResetKey((k) => k + 1);
        }
      } else {
        setMessage(null);
        alreadyReset.current = false;
      }
    };

    check();
    return clerk.addListener(check);
  }, [clerk]);

  return { message, resetKey };
}
