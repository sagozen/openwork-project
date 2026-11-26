import type { WarriorPlusConfig } from "../config";

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WarriorPlusSale {
  id: string;
  status: string;
  productIds: string[];
  offerId: string | null;
  refundDate: string | null;
  payments: Array<{ paymentNum: number | null; status: string }>;
  raw: Record<string, unknown>;
}

export interface WarriorPlusClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * REST API v2 client, used only for verification and reconciliation. Public endpoints never
 * call it. A 404 is a real "not found"; 429 and 5xx are retryable and never revoke access.
 */
export class WarriorPlusClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WarriorPlusClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://warriorplus.com/api/v2").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        apiKey: this.apiKey,
        authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
    });
    if (response.status === 404) return null;
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(`WarriorPlus responded ${response.status}`, response.status);
    }
    if (!response.ok) throw new Error(`WarriorPlus responded ${response.status}`);
    return response.json();
  }

  async getSale(saleId: string): Promise<WarriorPlusSale | null> {
    const body = await this.get(`/sales/${encodeURIComponent(saleId)}`);
    if (!body) return null;
    return normalizeSale(body);
  }

  async listSales(params: { from?: string; to?: string; page?: number } = {}): Promise<WarriorPlusSale[]> {
    const query = new URLSearchParams();
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    if (params.page) query.set("page", String(params.page));
    const body = await this.get(`/sales${query.toString() ? `?${query}` : ""}`);
    const items = Array.isArray(body)
      ? body
      : Array.isArray((body as Record<string, unknown>)?.sales)
        ? ((body as Record<string, unknown>).sales as unknown[])
        : Array.isArray((body as Record<string, unknown>)?.data)
          ? ((body as Record<string, unknown>).data as unknown[])
          : [];
    return items.map((item) => normalizeSale(item));
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return String(record.product_id ?? record.productId ?? record.id ?? "");
      }
      return "";
    })
    .filter(Boolean);
}

function normalizeSale(body: unknown): WarriorPlusSale {
  const root = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sale = (root.sale && typeof root.sale === "object" ? root.sale : root) as Record<string, unknown>;
  const paymentsRaw = Array.isArray(sale.payments) ? sale.payments : Array.isArray(root.payments) ? root.payments : [];
  return {
    id: String(sale.id ?? sale.sale_id ?? sale.saleId ?? root.id ?? ""),
    status: String(sale.status ?? root.status ?? "").toLowerCase(),
    productIds: [
      ...stringArray(sale.product_id ?? sale.productId ?? sale.products ?? sale.items),
      ...stringArray(root.products),
    ],
    offerId: sale.offer_id ? String(sale.offer_id) : sale.offerId ? String(sale.offerId) : null,
    refundDate: sale.refund_date ? String(sale.refund_date) : sale.refundDate ? String(sale.refundDate) : null,
    payments: paymentsRaw.map((payment) => {
      const record = (payment ?? {}) as Record<string, unknown>;
      const number = Number(record.payment_num ?? record.paymentNum ?? record.num ?? Number.NaN);
      return {
        paymentNum: Number.isFinite(number) ? number : null,
        status: String(record.status ?? record.payment_status ?? "").toLowerCase(),
      };
    }),
    raw: sale,
  };
}

/** Does a REST sale contain the product this purchase was made for? */
export function saleMatchesProduct(
  sale: WarriorPlusSale,
  purchase: { item_number: string; product_code: string },
  config: WarriorPlusConfig,
): boolean {
  if (sale.productIds.length === 0) return true;
  const configured = Object.values(config.products).find((product) => product.code === purchase.product_code);
  const candidates = new Set(
    [purchase.item_number, configured?.restId, configured?.code]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase()),
  );
  return sale.productIds.some((id) => candidates.has(id.toLowerCase()));
}
