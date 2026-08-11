/**
 * Minimal Prometheus HTTP API client, instant-query only.
 *
 * Source of truth for thresholds/queries: never edit here without editing
 * docs/reference/audio-slo-and-load-test-queries.md first.
 */
export class PromClient {
  constructor(baseUrl) {
    if (!baseUrl) throw new Error("PromClient requires baseUrl");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Runs an instant query. Returns the raw `data.result` array — each entry
   * shaped `{ metric: {...labels}, value: [ts, "val"] }`.
   */
  async instant(query, timeSec) {
    const url = new URL(`${this.baseUrl}/api/v1/query`);
    url.searchParams.set("query", query);
    if (timeSec !== undefined && timeSec !== null) {
      url.searchParams.set("time", String(timeSec));
    }

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PromClient.instant: HTTP ${res.status} for query "${query}": ${body}`);
    }

    const json = await res.json();
    if (json.status !== "success") {
      throw new Error(
        `PromClient.instant: query "${query}" returned status="${json.status}": ${json.error ?? ""}`,
      );
    }

    return json.data?.result ?? [];
  }
}
