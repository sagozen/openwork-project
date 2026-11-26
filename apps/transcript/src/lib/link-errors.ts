import type { SourceKind } from "./sources";

/**
 * Typed resolver errors are mapped to one short fix instruction per platform (phase 5
 * "private-link coaching"). The worker stores the code on the job; the UI renders the text.
 */
export type LinkErrorCode =
  | "not_public"
  | "login_required"
  | "removed"
  | "geo_blocked"
  | "too_long"
  | "unsupported"
  | "drm"
  | "private_address"
  | "insecure_url"
  | "malformed_url"
  | "source_disabled"
  | "source_unavailable"
  | "no_media"
  | "disk_full"
  | "worker_lost";

type Text = { en: string; vi: string };

const DEFAULT_TEXT: Record<LinkErrorCode, Text> = {
  not_public: {
    en: "This link is not public. Set sharing to “Anyone with the link” and paste it again.",
    vi: "Liên kết chưa công khai. Chọn chia sẻ “Bất kỳ ai có liên kết” rồi dán lại.",
  },
  login_required: {
    en: "This link needs a sign-in. Download the file and upload it instead.",
    vi: "Liên kết yêu cầu đăng nhập. Hãy tải tệp về rồi tải lên.",
  },
  removed: {
    en: "The file or video was removed or moved.",
    vi: "Tệp hoặc video đã bị xoá hoặc di chuyển.",
  },
  geo_blocked: {
    en: "The source blocks our region. Download the file and upload it.",
    vi: "Nguồn chặn khu vực của chúng tôi. Hãy tải tệp về rồi tải lên.",
  },
  too_long: {
    en: "This media is longer than the job limit for the worker that can take it.",
    vi: "Tệp dài hơn giới hạn của worker có thể xử lý.",
  },
  unsupported: {
    en: "That link is not supported. Use Drive, OneDrive, Dropbox, a direct MP3/MP4 link, YouTube or an upload.",
    vi: "Liên kết chưa được hỗ trợ. Dùng Drive, OneDrive, Dropbox, liên kết MP3/MP4 trực tiếp, YouTube hoặc tải tệp lên.",
  },
  drm: {
    en: "Streaming services with DRM cannot be transcribed. Download the audio you own and upload it.",
    vi: "Dịch vụ có DRM không thể bóc băng. Hãy tải âm thanh bạn sở hữu rồi tải lên.",
  },
  private_address: {
    en: "Private and local addresses are blocked.",
    vi: "Địa chỉ nội bộ và cục bộ bị chặn.",
  },
  insecure_url: {
    en: "Use an https link.",
    vi: "Hãy dùng liên kết https.",
  },
  malformed_url: {
    en: "That does not look like a link. Copy it again from the address bar.",
    vi: "Chuỗi này không giống liên kết. Hãy sao chép lại từ thanh địa chỉ.",
  },
  source_disabled: {
    en: "This source is temporarily disabled. Upload the file instead.",
    vi: "Nguồn này tạm thời bị tắt. Hãy tải tệp lên.",
  },
  source_unavailable: {
    en: "We could not reach the source. Try again, or upload the file.",
    vi: "Không truy cập được nguồn. Thử lại hoặc tải tệp lên.",
  },
  no_media: {
    en: "No audio or video file was found at that link.",
    vi: "Không tìm thấy tệp âm thanh hoặc video ở liên kết đó.",
  },
  disk_full: {
    en: "The worker is out of disk space. The job was requeued.",
    vi: "Worker hết dung lượng đĩa. Tác vụ đã được xếp lại.",
  },
  worker_lost: {
    en: "The worker stopped mid-job. It was requeued automatically.",
    vi: "Worker dừng giữa chừng. Tác vụ đã tự động xếp lại.",
  },
};

/** Platform-specific instruction that overrides the generic text where it helps. */
const BY_SOURCE: Partial<Record<SourceKind, Partial<Record<LinkErrorCode, Text>>>> = {
  gdrive: {
    not_public: {
      en: "In Drive: Share → General access → “Anyone with the link” → Viewer, then paste the link again.",
      vi: "Trong Drive: Chia sẻ → Quyền truy cập chung → “Bất kỳ ai có liên kết” → Người xem, rồi dán lại.",
    },
    login_required: {
      en: "Drive returned a sign-in page, so the file is restricted. Set “Anyone with the link”, or download it and upload.",
      vi: "Drive trả về trang đăng nhập, nghĩa là tệp bị hạn chế. Chọn “Bất kỳ ai có liên kết”, hoặc tải về rồi tải lên.",
    },
  },
  onedrive: {
    not_public: {
      en: "In OneDrive: Share → “Anyone with the link” → Can view, then paste the link again.",
      vi: "Trong OneDrive: Chia sẻ → “Bất kỳ ai có liên kết” → Có thể xem, rồi dán lại.",
    },
  },
  dropbox: {
    not_public: {
      en: "In Dropbox: Share → “Anyone with the link”, then paste it again.",
      vi: "Trong Dropbox: Chia sẻ → “Bất kỳ ai có liên kết”, rồi dán lại.",
    },
  },
  youtube: {
    not_public: {
      en: "The video is private or age-restricted. Use a public video or upload the audio.",
      vi: "Video ở chế độ riêng tư hoặc giới hạn độ tuổi. Dùng video công khai hoặc tải âm thanh lên.",
    },
    removed: {
      en: "YouTube says this video is unavailable. Check the link or upload the audio.",
      vi: "YouTube báo video không khả dụng. Kiểm tra liên kết hoặc tải âm thanh lên.",
    },
  },
  tiktok: {
    not_public: {
      en: "TikTok links must be public. Private or friends-only videos cannot be fetched.",
      vi: "Liên kết TikTok phải công khai. Video riêng tư hoặc chỉ bạn bè không lấy được.",
    },
  },
};

export function linkErrorText(code: string, source: SourceKind | null, locale: "en" | "vi"): string {
  const known = DEFAULT_TEXT[code as LinkErrorCode];
  const override = source ? BY_SOURCE[source]?.[code as LinkErrorCode] : undefined;
  const text = override ?? known;
  if (!text) {
    return locale === "vi"
      ? "Không xử lý được liên kết này. Hãy tải tệp lên."
      : "We could not process that link. Upload the file instead.";
  }
  return text[locale];
}
