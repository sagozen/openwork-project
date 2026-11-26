# Khoá học "ChatQA Software cơ bản"

Nguồn của khoá miễn phí trên `https://mytutorlms.zhst.app` (menu Learn của chatqasoft.zhst.app trỏ vào đây). Mọi nội dung nằm ở một file: [course.mjs](course.mjs) (giáo trình 6 chương, 19 bài, ghi chú, cảnh video, lời đọc). Sửa nội dung thì sửa file này rồi dựng lại.

| Thứ | Ở đâu |
|---|---|
| Giáo trình, ghi chú, lời đọc | `course.mjs` |
| Tài nguyên tải về (script PowerShell, cấu hình mẫu, câu lệnh mẫu, flow mẫu) | `resources/` |
| Ảnh màn app, slide, video, PDF (không đưa vào git) | `build/` |

## Dựng lại

Cần checkout hs-desk (để chụp giao diện ChatQASoftware và dùng Playwright của nó), ffmpeg có libx264, và venv VieNeu-TTS 3.8.3.

```sh
HS=/đường/dẫn/hs-desk
node docs/courses/chatqa/tools/capture-app-screens.mjs $HS docs/courses/chatqa/build/screens   # ảnh màn app, dữ liệu mẫu
cp $HS/apps/chatqa/web/visual/baseline/live-windows-1440x920.png docs/courses/chatqa/build/screens/live-windows.png
# build/brand (logo-mark.svg, logo-lockup-dark.svg từ $HS/docs/brand/chatqa) và build/fonts (Be Vietnam Pro, JetBrains Mono từ $HS/packages/ui-shell/src/assets/fonts)
node docs/courses/chatqa/tools/build-media.mjs $HS all            # slide 1920x1080 + 3 PDF
HF_HUB_OFFLINE=1 .venv-vieneu/bin/python docs/courses/chatqa/tools/build-videos.py --ffmpeg <ffmpeg>   # 19 video + phụ đề .srt
```

Giọng đọc: VieNeu-TTS v3 Turbo, giọng "Ngọc Huyền". Tên riêng tiếng Anh đọc qua bảng phiên âm `PRON` trong `build-videos.py` (đã kiểm bằng Whisper). Video là slide + giọng máy; khi quay màn hình thật, chỉ cần đặt file `.mp4` cùng tên rồi tải lên lại.

## Đưa lên site

```sh
node docs/courses/chatqa/tools/publish-course.mjs plan --remove <id khoá cũ>      # xem build/publish/apply.sql, course.json, media.json
node ops/scripts/backup-cloudflare.mjs --database <d1> --out backups/<ngày>        # luôn sao lưu trước
node docs/courses/chatqa/tools/publish-course.mjs upload --bucket <r2 media>
node docs/courses/chatqa/tools/publish-course.mjs apply --database <d1> --remove <id khoá cũ>
```

Media phục vụ công khai tại `/_emdash/api/media/file/courses/chatqa/<file>` (video tua được, PDF tải về). Bản ghi khoá giữ khuôn 0.3.0; khoá mở và tài nguyên thêm nằm ở `courseOptions`, chỉ có hiệu lực từ 0.4.0. Lịch Zoom nhập trong workspace: **Courses → khoá → Live sessions**.
