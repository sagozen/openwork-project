import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/ho-tro")({
  head: () => ({
    meta: [
      { title: "Hỗ trợ người dùng - DLP LIMS" },
      {
        name: "description",
        content:
          "Trung tâm hỗ trợ DLP LIMS: tài liệu hướng dẫn, gửi yêu cầu hỗ trợ và theo dõi phản hồi.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => <Outlet />,
});
