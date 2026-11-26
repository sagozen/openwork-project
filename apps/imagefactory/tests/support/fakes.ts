import type {
  ImageProvider,
  ProviderJob,
  ProviderRequest,
  ProviderResult,
  ProviderStatus,
} from "../../src/lib/images/provider";

/** In-memory stand-in for the R2 bucket binding, covering the calls the app makes. */
export class FakeBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType });
  }

  async get(key: string) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: new Blob([entry.bytes as BlobPart]).stream(),
      size: entry.bytes.byteLength,
      arrayBuffer: async () => entry.bytes.slice().buffer,
      httpEtag: `"${key}"`,
      httpMetadata: { contentType: entry.contentType },
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix?: string } = {}) {
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .map((key) => ({ key }));
    return { objects, truncated: false, cursor: undefined };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

export interface FakeProviderOptions {
  status?: ProviderStatus;
  result?: ProviderResult | (() => Promise<ProviderResult>);
  submitError?: Error;
}

/** Scriptable provider: tests set `status`/`result` between steps and read `submits`. */
export class FakeProvider implements ImageProvider {
  readonly id = "fal" as const;
  readonly submits: ProviderRequest[] = [];
  status_: ProviderStatus = { state: "queued", queuePosition: 1 };
  result_: ProviderResult | (() => Promise<ProviderResult>) = { images: [], seed: 7 };
  submitError?: Error;
  private counter = 0;

  constructor(options: FakeProviderOptions = {}) {
    if (options.status) this.status_ = options.status;
    if (options.result) this.result_ = options.result;
    this.submitError = options.submitError;
  }

  async submit(request: ProviderRequest): Promise<ProviderJob> {
    if (this.submitError) throw this.submitError;
    this.submits.push(request);
    this.counter += 1;
    const id = `req-${this.counter}`;
    return { providerJobId: id, statusUrl: `https://fal.test/${id}/status`, responseUrl: `https://fal.test/${id}` };
  }

  async status(): Promise<ProviderStatus> {
    return this.status_;
  }

  async result(): Promise<ProviderResult> {
    return typeof this.result_ === "function" ? this.result_() : this.result_;
  }
}

/** A 1x1 PNG, enough for the magic-byte sniffing and byte counts. */
export const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

export const fakeImageFetch = (async () =>
  new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
