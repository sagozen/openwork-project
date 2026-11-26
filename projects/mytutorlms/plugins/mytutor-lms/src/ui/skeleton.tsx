/** Placeholder blocks while content loads; the status text is for screen readers. */
export function Skeleton({
  lines = 3,
  label,
}: {
  lines?: number;
  label: string;
}) {
  return (
    <div className="mt-skeleton" role="status">
      <span className="mt-visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} aria-hidden="true" />
      ))}
    </div>
  );
}
