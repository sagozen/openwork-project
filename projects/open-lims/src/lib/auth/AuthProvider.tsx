import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ClerkProvider, useClerk, useSession, useUser } from "@clerk/tanstack-react-start";
import { PERSONAS, can, canViewAdminArea, type Permission, type Persona } from "@/lib/admin/rbac";
import { createIamApi } from "@/features/iam/api/iamApi";
import type { TokenProvider } from "@/lib/api";
import {
  iamErrorMessage,
  type IamBranch,
  type IamCapabilities,
  type IamUser,
} from "@/features/iam/types/iam";
import { CLERK_KEY, currentClerkDomain, type ClerkDomainConfig } from "@/lib/auth/clerk-domains";

const DEMO_KEY = "dlp.demo-persona";

/**
 * Việt hoá các thẻ giao diện do Clerk dựng.
 *
 * Vỏ trang quanh khung đăng nhập là tiếng Việt còn khung do Clerk dựng lại là tiếng Anh ("Sign in
 * to DLP LIMS · Welcome back! · Email address · Continue"), nên màn đầu tiên người dùng thấy nói
 * hai thứ tiếng.
 *
 * Chép tay từng chuỗi thay vì dùng gói `@clerk/localizations` (bản `viVN`) vì `npm install` trên
 * máy này đang hỏng cây phụ thuộc. Hệ quả cần biết: chỉ những màn liệt kê dưới đây được dịch -
 * quên mật khẩu, xác thực hai bước và các thông báo lỗi của Clerk vẫn là tiếng Anh. Khi
 * `npm install` chạy được thì thay khối này bằng `viVN` rồi merge riêng phần `restrictedAccess`.
 */
const CLERK_VI = {
  formFieldLabel__emailAddress: "Địa chỉ email",
  formFieldLabel__password: "Mật khẩu",
  formFieldLabel__emailAddress_username: "Email hoặc tên đăng nhập",
  formFieldInputPlaceholder__emailAddress: "Nhập email nội bộ",
  formFieldInputPlaceholder__password: "Nhập mật khẩu",
  formButtonPrimary: "Tiếp tục",
  dividerText: "hoặc",
  backButton: "Quay lại",
  footerActionLink__useAnotherMethod: "Dùng cách khác",
  signIn: {
    start: {
      title: "Đăng nhập {{applicationName}}",
      subtitle: "Đăng nhập để tiếp tục",
      actionText: "Chưa có tài khoản?",
      actionLink: "Liên hệ quản trị viên",
    },
    password: {
      title: "Nhập mật khẩu",
      subtitle: "Nhập mật khẩu của tài khoản nội bộ",
      actionLink: "Dùng cách khác",
    },
    emailCode: {
      title: "Kiểm tra hộp thư",
      subtitle: "Nhập mã xác minh vừa gửi tới email của anh/chị",
      formTitle: "Mã xác minh",
      resendButton: "Gửi lại mã",
    },
    forgotPasswordAlternativeMethods: {
      title: "Quên mật khẩu?",
      label__alternativeMethods: "Hoặc đăng nhập bằng cách khác",
      blockButton__resetPassword: "Đặt lại mật khẩu",
    },
    alternativeMethods: {
      title: "Dùng cách khác",
      actionLink: "Cần trợ giúp",
      blockButton__emailCode: "Gửi mã tới {{identifier}}",
      blockButton__password: "Đăng nhập bằng mật khẩu",
    },
  },
  signUp: {
    restrictedAccess: {
      title: "Tài khoản chưa được cấp quyền",
      subtitle:
        "Hệ thống chỉ dành cho tài khoản nội bộ được mời trước. Email này chưa nằm trong danh sách cho phép, vui lòng liên hệ quản trị viên để được cấp quyền.",
      subtitleWaitlist:
        "Hệ thống chỉ dành cho tài khoản nội bộ được mời trước. Vui lòng liên hệ quản trị viên để được cấp quyền.",
      actionText: "Đã có tài khoản nội bộ?",
      actionLink: "Đăng nhập",
      blockButton__emailSupport: "Liên hệ quản trị viên",
    },
  },
};

export interface AuthUser {
  /** Mã người dùng của hệ thống (`GET /me.userId`) - chính là giá trị mà bước bàn giao hỏi ở ô
   *  "người giao/nhận đối ứng", nên hồ sơ cá nhân phải hiện được nó. */
  id: string;
  name: string;
  email: string;
  initials: string;
  role: string;
  branch: string;
  perms: Permission[];
}

interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AuthUser | null;
  /**
   * Các chi nhánh người đang đăng nhập với tới được (`GET /me.branches`), giữ nguyên id + tên
   * thay vì chuỗi đã ghép của {@link AuthUser.branch}.
   *
   * <p>Đây là nguồn danh mục chi nhánh DUY NHẤT hiện có: chưa có endpoint `/branches` riêng, nên
   * bộ lọc hồ sơ và các bộ chọn chi nhánh dùng chung chỗ này thay vì mỗi nơi tự đoán một kiểu.
   * Rỗng ở chế độ minh hoạ - không có máy chủ nào để hỏi.
   */
  branches: IamBranch[];
  usesClerk: boolean;
  iamStatus: "loading" | "ready" | "denied" | "unavailable" | null;
  iamError: string | null;
  can: (perm: Permission) => boolean;
  signInDemo: (personaId: string) => void;
  signOut: () => Promise<void> | void;
  getToken: TokenProvider;
}

const AuthContext = createContext<AuthState | null>(null);

// "admin.view" không phải một mã quyền thật (backend không có) - nó là điều kiện tổng hợp
// "có bất kỳ quyền quản trị nào" mà rbac.ts tính từ các mã thật. Giữ nguyên tại đây để các
// màn hình dùng `can("admin.view")` không phải đổi cách gọi.
function resolveCan(perms: Permission[], perm: Permission): boolean {
  if (perm === "admin.view") return canViewAdminArea(perms);
  return can(perms, perm);
}

function personaToUser(p: Persona): AuthUser {
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    initials: p.initials,
    role: p.role,
    branch: p.branch,
    perms: p.perms,
  };
}

function DemoAuthBridge({ children }: { children: ReactNode }) {
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setPersonaId(window.localStorage.getItem(DEMO_KEY));
    setIsLoaded(true);
  }, []);

  const signInDemo = useCallback((id: string) => {
    window.localStorage.setItem(DEMO_KEY, id);
    setPersonaId(id);
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem(DEMO_KEY);
    setPersonaId(null);
  }, []);

  const persona = PERSONAS.find((p) => p.id === personaId) ?? null;
  const user = persona ? personaToUser(persona) : null;

  const value = useMemo<AuthState>(
    () => ({
      isLoaded,
      isSignedIn: !!user,
      user,
      branches: [],
      usesClerk: false,
      iamStatus: null,
      iamError: null,
      can: (perm) => (user ? resolveCan(user.perms, perm) : false),
      signInDemo,
      signOut,
      getToken: async () => null,
    }),
    [isLoaded, user, signInDemo, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function ClerkAuthBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  const { session } = useSession();
  const clerk = useClerk();
  const getToken = useCallback<TokenProvider>(
    () => session?.getToken() ?? Promise.resolve(null),
    [session],
  );
  const [iamProfile, setIamProfile] = useState<IamUser | null>(null);
  const [iamCapabilities, setIamCapabilities] = useState<IamCapabilities | null>(null);
  const [iamStatus, setIamStatus] = useState<AuthState["iamStatus"]>("loading");
  const [iamError, setIamError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !session) {
      setIamProfile(null);
      setIamCapabilities(null);
      setIamStatus(isLoaded ? null : "loading");
      setIamError(null);
      return;
    }
    setIamStatus("loading");
    setIamError(null);
    let cancelled = false;
    const api = createIamApi(getToken);
    void Promise.all([api.me(), api.capabilities()])
      .then(([profile, capabilities]) => {
        if (cancelled) return;
        setIamProfile(profile);
        setIamCapabilities(capabilities);
        setIamStatus("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setIamProfile(null);
        setIamCapabilities(null);
        setIamStatus(
          error instanceof Error && "status" in error && (error as { status: number }).status < 500
            ? "denied"
            : "unavailable",
        );
        setIamError(iamErrorMessage(error, "Không thể xác minh quyền IAM."));
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, session, getToken]);

  const user = useMemo<AuthUser | null>(() => {
    if (!isSignedIn || !iamProfile || !iamCapabilities) return null;
    const name = iamProfile.fullName;
    return {
      id: iamProfile.userId,
      name,
      email: iamProfile.email,
      initials: name
        .split(" ")
        .slice(-2)
        .map((part) => part.charAt(0))
        .join("")
        .toUpperCase(),
      role: iamProfile.roles.map((role) => role.name).join(", ") || "-",
      branch: iamProfile.branches.map((branch) => branch.name).join(", ") || "-",
      perms: iamCapabilities.permissions as Permission[],
    };
  }, [isSignedIn, iamProfile, iamCapabilities]);

  const value = useMemo<AuthState>(
    () => ({
      isLoaded: isLoaded && (!isSignedIn || iamStatus !== "loading"),
      isSignedIn: !!isSignedIn,
      user,
      branches: iamProfile?.branches ?? [],
      usesClerk: true,
      iamStatus,
      iamError,
      can: (perm) => (user ? resolveCan(user.perms, perm) : false),
      signInDemo: () => undefined,
      signOut: () => clerk.signOut(),
      getToken,
    }),
    [isLoaded, isSignedIn, user, iamProfile, iamStatus, iamError, clerk, getToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Quyết định dùng Clerk chỉ sau khi mount ở client: nếu tính ngay lúc render
  // đầu tiên, cây SSR (demo) khác cây client (Clerk) gây lệch hydrate và
  // context bị null trong lần render lỗi đó.
  const [clerkDomain, setClerkDomain] = useState<ClerkDomainConfig | null>(null);
  useEffect(() => {
    setClerkDomain(currentClerkDomain());
  }, []);

  if (!clerkDomain) return <DemoAuthBridge>{children}</DemoAuthBridge>;
  return (
    <ClerkProvider
      publishableKey={CLERK_KEY}
      localization={CLERK_VI}
      signInUrl={clerkDomain.signInUrl}
      signUpUrl={clerkDomain.signUpUrl}
      isSatellite={clerkDomain.isSatellite}
      {...(clerkDomain.domain ? { domain: clerkDomain.domain } : {})}
    >
      <ClerkAuthBridge>{children}</ClerkAuthBridge>
    </ClerkProvider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth phải nằm trong AuthProvider");
  return ctx;
}

export const clerkEnabled = () => currentClerkDomain() !== null;
