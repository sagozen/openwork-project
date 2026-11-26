// Where /api/events writes. The Cloudflare Worker sets this from its
// Analytics Engine binding (src/worker.ts); on the Node host it stays unset
// and events are accepted and dropped.
export interface AnalyticsSink {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

let sink: AnalyticsSink | null = null;
export const setAnalyticsSink = (value: AnalyticsSink | null) => {
  sink = value;
};
export const analyticsSink = () => sink;
