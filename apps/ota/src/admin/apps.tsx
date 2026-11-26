/**
 * Apps tab: each app is a separate namespace with its own tokens, releases and manifest.
 */

import type { SyntheticEvent } from "react";
import { useState } from "react";
import type { OtaApp, OtaInfo } from "../domain/types.js";
import { post, workspaceSlug } from "./client.js";
import { Failure, Section, when } from "./shared.js";
import { Badge, Button, Input, Switch } from "./ui.js";

export function AppsTab({ info, onChanged }: { info: OtaInfo; onChanged: () => void }) {
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const workspace = workspaceSlug();

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    setPending("save");
    setError(null);
    setNotice("");
    try {
      await post<OtaApp>("app-save", { slug: slug.trim(), name: name.trim(), enabled: true });
      setNotice(
        `Saved ${slug.trim()}. Devices use this value in the URL: /${workspace}/ota/${slug.trim()}/android/manifest.json`,
      );
      setSlug("");
      setName("");
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  }

  async function toggle(app: OtaApp, enabled: boolean) {
    setPending(app.slug);
    setError(null);
    try {
      await post("app-save", { slug: app.slug, name: app.name, enabled });
      onChanged();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending("");
    }
  }

  return (
    <>
      <Section
        title="Apps"
        description="Each app is a separate namespace: its own tokens, releases and manifest. Disabling an app stops reads and pushes for it."
      >
        <Failure error={error} />
        {info.apps.length === 0 ? (
          <p className="ota-muted">No apps yet. Add one below before creating push tokens.</p>
        ) : (
          <div className="ota-table-scroll" role="region" aria-label="OTA apps" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Slug</th>
                  <th scope="col">Name</th>
                  <th scope="col">State</th>
                  <th scope="col">Manifest URL</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {info.apps.map((app) => (
                  <tr key={app.slug}>
                    <th scope="row">
                      <code>{app.slug}</code>
                    </th>
                    <td>{app.name}</td>
                    <td>
                      {app.enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="error">Disabled</Badge>}
                    </td>
                    <td>
                      <code>
                        /{workspace}/ota/{app.slug}/&#123;platform&#125;/manifest.json
                      </code>
                    </td>
                    <td>{when(app.updatedAt)}</td>
                    <td>
                      <Switch
                        label={`Enable ${app.slug}`}
                        checked={app.enabled}
                        disabled={pending === app.slug}
                        onCheckedChange={(value) => void toggle(app, value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section
        title="Add or rename an app"
        description="The slug is permanent once CI and the apps use it; renaming keeps the same releases."
      >
        <form className="ota-token-form" onSubmit={(event) => void submit(event)}>
          <Input
            label="Slug"
            required
            placeholder="my-app"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <Input
            label="Display name"
            required
            placeholder="My App"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={pending !== "" || slug.trim() === "" || name.trim() === ""}>
            {pending === "save" ? "Saving…" : "Save app"}
          </Button>
        </form>
        {notice === "" ? null : (
          <p className="ota-notice" role="status">
            {notice}
          </p>
        )}
      </Section>
    </>
  );
}
