import { CopyButton } from "./CopyButton.js";

export function ConnectorUrl({ url }: { url: string }) {
  return (
    <div className="w-copyrow">
      <code>{url}</code>
      <CopyButton value={url} label="Copy URL" />
    </div>
  );
}
