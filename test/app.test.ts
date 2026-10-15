import { describe, expect, test } from "bun:test";
import { handle, type Fetcher } from "../app.ts";

const origin = "https://fx.purduehackers.com";
const tweet = {
  id_str: "123", text: '<script>alert("no")</script> hello https://t.co/media',
  user: { name: 'A & "B"', screen_name: "alice" },
  entities: { media: [{ url: "https://t.co/media" }] },
  mediaDetails: [{ type: "video", media_url_https: "https://pbs.twimg.com/poster.jpg",
    original_info: { width: 1280, height: 720 }, video_info: { variants: [
      { content_type: "application/x-mpegURL", url: "https://video.twimg.com/stream.m3u8" },
      { content_type: "video/mp4", bitrate: 100, url: "https://video.twimg.com/low.mp4" },
      { content_type: "video/mp4", bitrate: 500, url: "https://video.twimg.com/high.mp4" },
    ] } }],
};
const instagram = {
  shortcode: "ABCDE12345", owner: { username: "alice" },
  edge_media_to_caption: { edges: [{ node: { text: "hello <world>" } }] },
  edge_sidecar_to_children: { edges: [
    { node: { is_video: false, display_url: "https://scontent.cdninstagram.com/photo.jpg", dimensions: { width: 1080, height: 1080 } } },
    { node: { is_video: true, video_url: "https://scontent.cdninstagram.com/reel.mp4", display_url: "https://scontent.cdninstagram.com/poster.jpg", dimensions: { width: 1080, height: 1920 } } },
  ] },
};
const soundcloud = { title: 'A track by Alice', author_name: "Alice", thumbnail_url: "https://i1.sndcdn.com/art.jpg", html: "<iframe>unwanted player</iframe>" };
const legacyHTML = (data: unknown) => `<script>callback(${JSON.stringify(JSON.stringify({ gql_data: { shortcode_media: data } }))});</script>`;

const upstream: Fetcher = async input => {
  const url = new URL(input);
  if (url.hostname === "cdn.syndication.twimg.com") return Response.json(tweet);
  if (url.hostname === "www.instagram.com") return new Response(legacyHTML(instagram));
  if (url.hostname === "soundcloud.com" && url.pathname === "/oembed") return Response.json(soundcloud);
  throw new Error(`Unexpected upstream: ${url}`);
};
const request = (path: string, fetcher = upstream, init?: RequestInit) => handle(new Request(origin + path, init), fetcher);

test.each(["/", "/?url=https://x.com/alice/status/123", "/health", "/alice/status/123", "/s/alice/status/123", "/i/alice/status/123"])("%s has no page or upstream fetch", async path => {
  let calls = 0;
  const response = await request(path, async () => { calls++; return Response.json(tweet); });
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(calls).toBe(0);
});

test.each(["/t/i/web/status/123", "/i/alice/p/ABCDE12345/?img_index=2", "/i/reels/ABCDE12345/", "/s/alice/sets/playlist"])("keeps %s working", async path => {
  expect((await request(path)).status).toBe(200);
});

describe("embeds", () => {
  test("X embeds select MP4 and escape all upstream text", async () => {
    const response = await request("/t/alice/status/123");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('property="og:video" content="https://video.twimg.com/high.mp4"');
    expect(body).toContain('content="video/mp4"');
    expect(body).toContain('&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;');
    expect(body).not.toContain('<script>alert(');
    expect(body).not.toContain("https://t.co/media");
    expect(body).not.toContain("stream.m3u8");
  });

  test("browser and crawler responses are identical for safe shared caching", async () => {
    const browser = await request("/t/alice/status/123", upstream, { headers: { "user-agent": "Mozilla/5.0" } });
    const crawler = await request("/t/alice/status/123", upstream, { headers: { "user-agent": "Discordbot/2.0" } });
    expect(browser.headers.get("cache-control")).toContain("s-maxage=300");
    expect(await browser.text()).toBe(await crawler.text());
  });

  test("Instagram carousel selection preserves media type and dimensions", async () => {
    const image = await request("/i/p/ABCDE12345/");
    const video = await request("/i/p/ABCDE12345/?media=2&preview=1");
    expect(await image.text()).toContain('property="og:image" content="https://scontent.cdninstagram.com/photo.jpg"');
    const body = await video.text();
    expect(body).toContain('property="og:video:height" content="1920"');
    expect(body).toContain("location.replace");
    expect(body).not.toMatch(/<video|<style|<form|preview=1.*>Preview/);
  });

  test("direct media redirects, HEAD, and unsupported methods", async () => {
    const direct = await request("/i/p/ABCDE12345/?media=2&direct=1");
    expect(direct.status).toBe(302);
    expect(direct.headers.get("location")).toBe("https://scontent.cdninstagram.com/reel.mp4");
    const head = await request("/t/alice/status/123", upstream, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");
    expect((await request("/t/alice/status/123", upstream, { method: "POST" })).status).toBe(405);
  });

  test("oEmbed discovery resolves to local metadata", async () => {
    const body = await (await request("/t/alice/status/123")).text();
    const discovery = body.match(/type="application\/json\+oembed" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const response = await handle(new Request(discovery), upstream);
    expect(await response.json()).toMatchObject({ type: "link", author_name: 'A & "B" (@alice)', provider_name: "X · EmbedFix" });
  });

  test("SoundCloud returns title and artwork without the upstream iframe", async () => {
    const response = await request("/s/alice/track");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('property="og:title" content="A track by Alice"');
    expect(body).toContain('property="og:type" content="music.song"');
    expect(body).toContain("https://i1.sndcdn.com/art.jpg");
    expect(body).not.toContain("<iframe");
    expect(body).not.toContain("og:video");
  });

  test("short SoundCloud links resolve to a canonical track", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (input, init) => {
      calls.push(String(input));
      if (new URL(input).hostname === "on.soundcloud.com") {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 302, headers: { location: "https://soundcloud.com/alice/track?si=tracking" } });
      }
      return upstream(input, init);
    };
    const response = await request("/s/AbCdEf", fetcher);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('rel="canonical" href="https://soundcloud.com/alice/track"');
    expect(calls).toHaveLength(2);
  });
});

describe("upstream failures and parsing", () => {
  test("parses modern Instagram hydration JSON for the requested post only", async () => {
    const data = { code: "ABCDE12345", user: { username: "alice" }, media_type: 2,
      image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/a.jpg", width: 1080, height: 1920 }] },
      video_versions: [{ url: "https://scontent.cdninstagram.com/a.mp4", width: 1080 }] };
    const html = `<script type="application/json">${JSON.stringify({ require: [{ data: { xig_polaris_media: { if_not_gated_logged_out: data } } }] })}</script>`;
    const fetcher: Fetcher = async () => new Response(html);
    const response = await request("/i/p/ABCDE12345/", fetcher);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('property="og:video" content="https://scontent.cdninstagram.com/a.mp4"');
    expect((await request("/i/p/wrongID/", fetcher)).status).toBe(502);
  });

  test("falls back to the public Instagram page when the embed is empty", async () => {
    const calls: string[] = [];
    const response = await request("/i/p/ABCDE12345/", async input => {
      calls.push(String(input));
      return new Response(calls.length === 1 ? "<html>Login required</html>" : legacyHTML(instagram));
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://www.instagram.com/p/ABCDE12345/embed/captioned/", "https://www.instagram.com/p/ABCDE12345/"]);
  });

  test("never presents a blocked Instagram video's thumbnail as playable", async () => {
    const data = { shortcode: "ABCDE12345", owner: { username: "alice" }, is_video: true, display_url: "https://scontent.cdninstagram.com/poster.jpg" };
    const response = await request("/i/reel/ABCDE12345/", async () => new Response(legacyHTML(data)));
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain('property="og:video"');
  });

  test("unavailable, malformed, and rate-limited upstreams are not cached as success", async () => {
    for (const make of [() => Response.json({ __typename: "TweetTombstone" }), () => new Response("rate limited", { status: 429 }), () => new Response("not JSON")]) {
      const response = await request("/t/alice/status/123", async () => make());
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("rejects invalid or missing media selections", async () => {
    for (const query of ["media=0", "media=-1", "media=1.5", "media=NaN", "media=21", "media="]) {
      expect((await request("/i/p/ABCDE12345/?" + query)).status).toBe(400);
    }
    expect((await request("/i/p/ABCDE12345/?media=3")).status).toBe(404);
  });

  test("rejects external oEmbed input without fetching it", async () => {
    let calls = 0;
    const response = await request("/oembed?url=https://localhost/t/alice/status/123", async () => { calls++; return Response.json(tweet); });
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("rejects hostile SoundCloud redirects before fetching them", async () => {
    for (const location of ["https://127.0.0.1/secret", "https://soundcloud.com.evil.com/a/b", "http://on.soundcloud.com@127.0.0.1/secret", "https://x.com/alice/status/123"]) {
      let calls = 0;
      const response = await request("/s/AbCdEf", async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      });
      expect(response.status).toBe(502);
      expect(calls).toBe(1);
    }
  });

  test("bounds SoundCloud redirect loops", async () => {
    let calls = 0;
    const response = await request("/s/AbCdEf", async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://on.soundcloud.com/AbCdEf" } });
    });
    expect(response.status).toBe(502);
    expect(calls).toBe(4);
  });

  test("a video URL is never used as a missing thumbnail", async () => {
    const data = structuredClone(tweet);
    data.mediaDetails[0]!.media_url_https = "";
    const response = await request("/t/alice/status/123", async () => Response.json(data));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('property="og:video"');
    expect(body).not.toContain('property="og:image"');
  });

  test("does not embed media URLs outside the platform CDNs", async () => {
    const data = structuredClone(tweet);
    data.mediaDetails[0]!.video_info.variants = [{ content_type: "video/mp4", bitrate: 10, url: "https://video.twimg.com.evil.com/a.mp4" }];
    expect((await request("/t/alice/status/123", async () => Response.json(data))).status).toBe(502);
  });

  test("bounds upstream response sizes", async () => {
    const response = await request("/t/alice/status/123", async () => new Response("x".repeat(3_000_001)));
    expect(response.status).toBe(502);
  });
});
