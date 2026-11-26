// Chỗ gắn màn gửi yêu cầu của feature vipo-sheet-exchange. Khi feature đó có màn thật, thay phần tử của route trong App.tsx bằng màn đó.
export default function VipoRequestPlaceholder() {
  return (
    <div className="stroke-in flex flex-1 items-center justify-center rounded-[12px] bg-surface p-[24px] text-center text-[13px]/[20px] text-text-2">
      Màn gửi yêu cầu báo giá thuộc feature vipo-sheet-exchange và sẽ gắn vào khung này.
    </div>
  );
}
