import { describe, expect, mock, test } from "bun:test";
import { createHandler, type Fetcher } from "./handler.ts";

const origin = "https://fx.purduehackers.com";
const path = "/t/example/status/123456789";
const request = (path: string, method = "GET") => new Request(origin + path, { method });
const statusPath = (path: string) => `/api/v1/statuses/${BigInt(`0x${Buffer.from(path).toString("hex")}`)}`;
const tweet = (id = "123456789") => ({
  id_str: id, text: "A public post", user: { screen_name: "example", name: "Example" },
  mediaDetails: [1, 2].map(n => ({ type: "photo", media_url_https: `https://pbs.twimg.com/media/${n}.jpg` })),
});
const twitter = mock<Fetcher>(async url => Response.json(tweet(new URL(url).searchParams.get("id")!)));

describe("shared post metadata", () => {
  test("HTML, oEmbed, status, and HEAD share one upstream fetch", async () => {
    const fetcher = mock<Fetcher>(twitter);
    const handle = createHandler(fetcher);
    const html = await handle(request(path));
    expect(await html.text()).toContain("A public post");
    const oembed = await handle(request(`/oembed?url=${encodeURIComponent(origin + path)}`));
    expect((await oembed.json()).author_name).toBe("Example");
    const activity = await handle(request(statusPath(path)));
    expect((await activity.json()).media_attachments).toHaveLength(2);
    const head = await handle(request(path, "HEAD"));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("concurrent aliases and media selections share a fetch without mutating the gallery", async () => {
    const ready = Promise.withResolvers<void>();
    const fetcher = mock<Fetcher>(async () => { await ready.promise; return Response.json(tweet()); });
    const handle = createHandler(fetcher);
    const responses = Promise.all([
      handle(request(statusPath(path + "?media=2"))),
      handle(request(statusPath("/t/another/status/123456789/photo/1"))),
      handle(request(statusPath(path))),
    ]);
    ready.resolve();
    const [second, first, all] = await Promise.all((await responses).map(response => response.json()));
    expect(second.media_attachments.map((media: { url: string }) => media.url)).toEqual(["https://pbs.twimg.com/media/2.jpg"]);
    expect(first.media_attachments.map((media: { url: string }) => media.url)).toEqual(["https://pbs.twimg.com/media/1.jpg"]);
    expect(all.media_attachments).toHaveLength(2);
    expect((await (await handle(request(statusPath(path)))).json()).media_attachments).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("memory reuse reduces CDN freshness instead of extending it", async () => {
    let now = 0;
    const fetcher = mock<Fetcher>(twitter);
    const handle = createHandler(fetcher, () => now);
    expect((await handle(request(path))).headers.get("cache-control")).toContain("s-maxage=300,");
    now = 290_500;
    expect((await handle(request(path))).headers.get("cache-control")).toContain("s-maxage=9,");
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 300_000;
    expect((await handle(request(path))).headers.get("cache-control")).toContain("s-maxage=300,");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("failed upstream requests are shared only while pending, then retried", async () => {
    const fetcher = mock<Fetcher>(async () => new Response("unavailable", { status: 503 }));
    const handle = createHandler(fetcher);
    const failed = await Promise.all([handle(request(path)), handle(request(statusPath(path)))]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const response of failed) {
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    fetcher.mockImplementation(twitter);
    expect((await handle(request(path))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("evicts least-recently-used posts at the entry limit", async () => {
    const fetcher = mock<Fetcher>(twitter);
    const handle = createHandler(fetcher);
    for (let id = 1; id <= 128; id++) await handle(request(`/t/example/status/${id}`));
    await handle(request("/t/example/status/1"));
    await handle(request("/t/example/status/129"));
    await handle(request("/t/example/status/1"));
    expect(fetcher).toHaveBeenCalledTimes(129);
    await handle(request("/t/example/status/2"));
    expect(fetcher).toHaveBeenCalledTimes(130);
  });

  test("rejects invalid selections and foreign oEmbed origins before fetching", async () => {
    const fetcher = mock<Fetcher>(twitter);
    const handle = createHandler(fetcher);
    for (const path of ["/t/example/status/123456789?media=21", "/oembed?url=https://evil.example/t/example/status/123456789"]) {
      expect((await handle(request(path))).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await handle(request(path + "?media=3"))).status).toBe(404);
    const direct = await handle(request(path + "?media=2&direct=1"));
    expect(direct.status).toBe(302);
    expect(direct.headers.get("location")).toBe("https://pbs.twimg.com/media/2.jpg");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("renders discovery URLs for each request origin without caching rendered HTML", async () => {
    const fetcher = mock<Fetcher>(twitter);
    const handle = createHandler(fetcher);
    await handle(new Request("https://preview.example" + path));
    const html = await (await handle(request(path))).text();
    expect(html).toContain(origin + "/users/");
    expect(html).not.toContain("preview.example");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("other providers", () => {
  test("Instagram aliases and selections reuse metadata and retain the correct original", async () => {
    const data = { shortcode: "ABCDE12", display_url: "https://scontent.cdninstagram.com/one.jpg",
      owner: { username: "example" }, edge_sidecar_to_children: { edges: [1, 2].map(n => ({ node: {
        display_url: `https://scontent.cdninstagram.com/${n}.jpg`,
      } })) } };
    const fetcher = mock<Fetcher>(async () => new Response(`<script>${JSON.stringify({ shortcode_media: data })}</script>`));
    const handle = createHandler(fetcher);
    const selected = await (await handle(request(statusPath("/i/reel/ABCDE12?img_index=2")))).json();
    expect(selected.media_attachments).toHaveLength(1);
    expect(selected.url).toBe("https://www.instagram.com/reel/ABCDE12");
    const all = await (await handle(request(statusPath("/i/p/ABCDE12")))).json();
    expect(all.url).toBe("https://www.instagram.com/p/ABCDE12");
    expect(all.media_attachments).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("SoundCloud reuses hydration and the accepted eight-character Braille waveform", async () => {
    const data = { title: "Track", user: { username: "Artist", permalink: "artist" }, duration: 60_000,
      waveform_url: "https://wave.sndcdn.com/track.json", artwork_url: "https://i1.sndcdn.com/art-large.jpg" };
    const fetcher = mock<Fetcher>(async url => new URL(url).hostname === "wave.sndcdn.com"
      ? Response.json({ samples: [1, 2, 3, 4, 5, 6, 7, 8] })
      : new Response(`<script>window.__sc_hydration = ${JSON.stringify([{ hydratable: "sound", data }])};</script>`));
    const handle = createHandler(fetcher);
    const html = await (await handle(request("/s/artist/track"))).text();
    expect(html).toMatch(/[⠂⠆⠇⡇]{8} 1:00/);
    const oembed = await handle(request(`/oembed?url=${encodeURIComponent(origin + "/s/artist/track")}`));
    expect((await oembed.json()).author_name).toBe("Artist");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("a short-link redirect still cannot reach another host", async () => {
    const fetcher = mock<Fetcher>(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/artist/track" } }));
    const handle = createHandler(fetcher);
    expect((await handle(request("/s/AbCd12"))).status).toBe(502);
    expect((await handle(request("/s/AbCd12"))).status).toBe(502);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).hostname)).toEqual(["on.soundcloud.com", "on.soundcloud.com"]);
  });
});
