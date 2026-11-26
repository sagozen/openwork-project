import { createFileRoute } from "@tanstack/react-router";
import { SampleResultWorkspace } from "@/components/lims/result/SampleResultWorkspace";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { searchString } from "@/lib/route-search";
export const Route = createFileRoute("/_app/nhap-ket-qua")({
  validateSearch: (s: Record<string, unknown>): { code?: string } => ({
    code: searchString(s["code"]),
  }),
  head: () => ({
    meta: [{ title: "Nhập kết quả thử nghiệm - DLP LIMS" }, { name: "robots", content: "noindex" }],
  }),
  component: Screen,
});
function Screen() {
  const { can } = useAuth();
  const { code } = Route.useSearch();
  return can(PERM.LAB_READ) ? (
    <SampleResultWorkspace sampleCode={code ?? ""} />
  ) : (
    <NoAccess screen="Nhập kết quả" />
  );
}
