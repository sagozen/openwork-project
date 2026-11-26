// Video giới thiệu ở đầu trang chủ: tự phát khi tắt tiếng và lặp lại (trình duyệt chỉ cho tự phát khi tắt tiếng).
// Luôn có thanh điều khiển của trình duyệt để bật tiếng, tua, toàn màn hình; phụ đề bật sẵn để người xem không bật tiếng vẫn theo được.
// Có avatar thì một video tắt tiếng (nhân vật nói khớp lồng tiếng) nằm trong ô tròn ở góc dưới và chạy theo video chính.
import { useEffect, useRef } from 'react';
import type { LandingVideo } from './landing-types';

/** Lệch quá ngưỡng này (giây) thì kéo avatar về đúng thời điểm của video chính. */
const MAX_DRIFT = 0.35;

export function HeroVideo({ video }: { video: LandingVideo }) {
  const mainRef = useRef<HTMLVideoElement>(null);
  const avatarRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const main = mainRef.current;
    const avatar = avatarRef.current;
    if (!main || !avatar) return;
    const align = () => {
      if (Math.abs(avatar.currentTime - main.currentTime) > MAX_DRIFT) avatar.currentTime = main.currentTime;
      // Video chính lặp lại từ đầu mà không dừng: avatar đã hết thì cho chạy tiếp.
      if (!main.paused && avatar.paused) void avatar.play().catch(() => {});
    };
    const play = () => align();
    const pause = () => avatar.pause();
    const rate = () => {
      avatar.playbackRate = main.playbackRate;
    };
    main.addEventListener('play', play);
    main.addEventListener('playing', play);
    main.addEventListener('pause', pause);
    main.addEventListener('waiting', pause);
    main.addEventListener('seeked', align);
    main.addEventListener('timeupdate', align);
    main.addEventListener('ratechange', rate);
    if (!main.paused) play();
    return () => {
      main.removeEventListener('play', play);
      main.removeEventListener('playing', play);
      main.removeEventListener('pause', pause);
      main.removeEventListener('waiting', pause);
      main.removeEventListener('seeked', align);
      main.removeEventListener('timeupdate', align);
      main.removeEventListener('ratechange', rate);
    };
  }, [video.avatar]);

  return (
    <div className="relative w-full overflow-hidden rounded-[14px] bg-chrome shadow-[0_24px_60px_rgba(14,16,20,0.16)] ring-1 ring-border">
      <video
        ref={mainRef}
        className="block aspect-video w-full"
        src={video.src}
        poster={video.poster}
        autoPlay
        muted
        loop
        playsInline
        controls
        preload="metadata"
        aria-label={video.label}
      >
        {video.subtitles ? (
          <track kind="subtitles" src={video.subtitles.src} srcLang={video.subtitles.lang} label={video.subtitles.label} default />
        ) : null}
      </video>
      {video.avatar ? (
        // Đặt cao hơn thanh điều khiển của trình duyệt; không nhận chuột để bấm xuyên xuống video. Ẩn trên màn hình nhỏ.
        <video
          ref={avatarRef}
          className="pointer-events-none absolute right-[14px] bottom-[58px] hidden aspect-square w-[18%] max-w-[150px] rounded-full object-cover shadow-[0_8px_24px_rgba(14,16,20,0.35)] ring-[3px] ring-white sm:block"
          src={video.avatar.src}
          poster={video.avatar.poster}
          muted
          playsInline
          preload="auto"
          aria-hidden
        />
      ) : null}
    </div>
  );
}
