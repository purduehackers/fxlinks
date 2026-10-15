export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Data = Record<string, any>;
type Media = { image?: string; video?: string; width?: number; height?: number };
class HttpError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const sources = {
  t: { name: "X", origin: "https://x.com", cdns: ["twimg.com"],
    path: /^\/(?:\w{1,15}|i\/web)\/status\/(\d{1,25})(?:\/(?:photo|video)\/(\d+))?\/?$/ },
  i: { name: "Instagram", origin: "https://www.instagram.com", cdns: ["cdninstagram.com", "fbcdn.net"],
    path: /^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,32})(?:\/(\d+))?\/?$/ },
  s: { name: "SoundCloud", origin: "https://soundcloud.com", cdns: ["sndcdn.com"],
    path: /^\/(?:[\w-]{1,200}\/(?:sets\/)?[\w-]{1,200}|[a-zA-Z0-9]{4,100})\/?$/ },
};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];
const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

function mediaURL(value: unknown, cdns: string[]): string | undefined {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        cdns.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
  } catch {}
}

function bestMedia(items: unknown, cdns: string[], mime?: string): Data | undefined {
  return list(items).filter(v => mediaURL(v.url, cdns) && (!mime || v.content_type === mime))
    .sort((a, b) => (b.bitrate ?? b.width ?? 0) - (a.bitrate ?? a.width ?? 0))[0];
}

async function read(url: string | URL, fetcher: Fetcher): Promise<string> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError("Source unavailable.", response.status === 404 ? 404 : 502);
  }
  let size = 0;
  return new Response(response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
    if ((size += chunk.byteLength) > 3_000_000) throw new HttpError("Source response too large.");
    controller.enqueue(chunk);
  } }))).text();
}

function findInstagram(value: any, id: string, depth = 0): Data | undefined {
  if (depth > 40 || !value) return;
  if (typeof value === "string") {
    try { return findInstagram(JSON.parse(value), id, depth + 1); } catch { return; }
  }
  if (typeof value !== "object") return;
  if ((value.shortcode === id || value.code === id) &&
      (value.display_url || value.image_versions2 || value.carousel_media || value.edge_sidecar_to_children)) return value;
  for (const child of Object.values(value)) {
    const found = findInstagram(child, id, depth + 1);
    if (found) return found;
  }
}

function instagramData(html: string, id: string): Data | undefined {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script || !/shortcode_media|xig_polaris_media|image_versions2/.test(script)) continue;
    // Legacy embeds double-encode JSON in JS string literals; never evaluate JS.
    const candidates = [script, ...Array.from(script.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g), m => m[0])];
    for (const candidate of candidates) {
      try {
        const data = findInstagram(JSON.parse(candidate), id);
        if (data) return data;
      } catch {}
    }
  }
}

function instagramPost(data: Data) {
  const user = data.owner ?? data.user;
  if (typeof user?.username !== "string" || !user.username) throw new HttpError("Invalid Instagram response.");
  const media = list(data.edge_sidecar_to_children?.edges?.map((e: Data) => e?.node) ?? data.carousel_media ?? [data]).slice(0, 20).map(item => {
    const imageData = bestMedia(item.image_versions2?.candidates, sources.i.cdns);
    const image = mediaURL(item.display_url || imageData?.url, sources.i.cdns);
    const video = mediaURL(item.video_url || bestMedia(item.video_versions, sources.i.cdns)?.url, sources.i.cdns);
    const isVideo = item.is_video === true || item.media_type === 2 || /Video/.test(item.__typename) || !!item.video_url || !!video;
    if (isVideo && !video || !isVideo && !image) throw new HttpError("Instagram media unavailable or requires login.");
    return { image, video, width: dimension(item.dimensions?.width ?? item.original_width ?? imageData?.width),
      height: dimension(item.dimensions?.height ?? item.original_height ?? imageData?.height) };
  });
  if (!media.length) throw new HttpError("Instagram returned no media.");
  return { author: `${user.full_name || user.username} (@${user.username})`,
    text: data.edge_media_to_caption?.edges?.[0]?.node?.text ?? data.caption?.text ?? "", media };
}

async function loadPost(url: URL, fetcher: Fetcher) {
  const key = url.pathname[1] as keyof typeof sources;
  const source = sources[key];
  const path = url.pathname.slice(2).replace(/\/$/, "");
  const match = source?.path.exec(path);
  if (!match) throw new HttpError("Not found.", 404);
  const selection = url.searchParams.get("media") ?? url.searchParams.get("img_index") ?? match[2];
  if (selection !== undefined && (!/^[1-9]\d*$/.test(selection) || Number(selection) > 20)) throw new HttpError("Invalid media number.", 400);
  const index = Number(selection ?? 1) - 1;
  let original = new URL(source.origin + path);
  if (match[2]) original.pathname = path.replace(/\/(?:(?:photo|video)\/)?\d+$/, "");
  let title: string, author: string, text: string, media: Media[];

  if (key === "s") {
    if (!path.slice(1).includes("/")) {
      original.hostname = "on.soundcloud.com";
      const signal = AbortSignal.timeout(10_000);
      for (let hop = 0; hop < 4 && original.hostname === "on.soundcloud.com"; hop++) {
        const response = await fetcher(original, { redirect: "manual", signal });
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
        const next = new URL(location, original);
        const host = next.hostname.replace(/^(www|m|mobile)\./, "");
        const short = !next.pathname.slice(1).replace(/\/$/, "").includes("/");
        if (!/^https?:$/.test(next.protocol) || next.username || next.password || next.port ||
            !["soundcloud.com", "on.soundcloud.com"].includes(host) || !source.path.test(next.pathname) ||
            short !== (host === "on.soundcloud.com")) throw new HttpError("Invalid SoundCloud redirect.");
        original = new URL(`https://${host}${next.pathname}`);
      }
      if (original.hostname === "on.soundcloud.com") throw new HttpError("Could not resolve SoundCloud link.");
    }
    const data = JSON.parse(await read(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(original.href)}`, fetcher));
    if (typeof data?.title !== "string" || !data.title || typeof data.author_name !== "string" || !data.author_name) throw new HttpError("Invalid SoundCloud response.");
    title = data.title;
    author = data.author_name;
    text = `By ${author}`;
    const image = mediaURL(data.thumbnail_url, source.cdns);
    media = image ? [{ image }] : [];
  } else if (key === "t") {
    const token = (Number(match[1]) / 1e15 * Math.PI).toString(36).replace(/[0.]/g, "");
    const data = JSON.parse(await read(`https://cdn.syndication.twimg.com/tweet-result?id=${match[1]}&lang=en&token=${token}`, fetcher));
    if (!data || data.__typename === "TweetTombstone" || !Object.keys(data).length) throw new HttpError("Post unavailable.", 404);
    if (data.id_str !== match[1] || !data.user?.screen_name || typeof data.text !== "string") throw new HttpError("Invalid X response.");
    author = `${data.user.name || data.user.screen_name} (@${data.user.screen_name})`;
    title = author;
    text = data.note_tweet?.text || data.text;
    for (const entity of list(data.entities?.urls)) {
      if (entity.url && entity.expanded_url) text = text.replaceAll(entity.url, entity.expanded_url);
    }
    for (const entity of list(data.entities?.media)) {
      if (entity.url) text = text.replaceAll(entity.url, "");
    }
    media = list(data.mediaDetails).slice(0, 20).map(item => {
      const image = mediaURL(item.media_url_https, source.cdns);
      const video = mediaURL(bestMedia(item.video_info?.variants, source.cdns, "video/mp4")?.url, source.cdns);
      const isVideo = ["video", "animated_gif"].includes(item.type);
      if (isVideo && !video || !isVideo && (item.type !== "photo" || !image)) throw new HttpError("Media unavailable.");
      return { image, video, width: dimension(item.original_info?.width), height: dimension(item.original_info?.height) };
    });
  } else {
    let post: ReturnType<typeof instagramPost> | undefined, failure: unknown;
    for (const suffix of ["embed/captioned/", ""]) {
      try {
        const data = instagramData(await read(`https://www.instagram.com/p/${match[1]}/${suffix}`, fetcher), match[1]!);
        if (data) { post = instagramPost(data); break; }
      } catch (error) { failure = error; }
    }
    if (!post) throw failure ?? new HttpError("Instagram post unavailable.");
    ({ author, text, media } = post);
    title = author;
  }
  if ((selection !== undefined || url.searchParams.get("direct") === "1") && !media[index]) throw new HttpError("Media not found.", 404);
  return { title, author, text: text.trim().slice(0, 4000), media: media[index], original, source };
}

export async function handle(request: Request, fetcher: Fetcher = fetch): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  let body = "", status = 200;
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      headers.set("allow", "GET, HEAD");
      throw new HttpError("Method not allowed.", 405);
    }
    const url = new URL(request.url);
    const isOembed = url.pathname === "/oembed";
    let target = url;
    if (isOembed) {
      try { target = new URL(url.searchParams.get("url") ?? ""); } catch { throw new HttpError("Invalid embed URL.", 400); }
      if (target.origin !== url.origin) throw new HttpError("Invalid embed origin.", 400);
    }
    const { title, author, text, media, original, source } = await loadPost(target, fetcher);
    if (!isOembed && url.searchParams.get("direct") === "1") {
      status = 302;
      headers.set("location", (media?.video || media?.image)!);
    } else {
      headers.set("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=30");
      if (isOembed) {
        headers.set("content-type", "application/json");
        body = JSON.stringify({ version: "1.0", type: "link", title: source.name === "SoundCloud" ? title : text, author_name: author,
          author_url: original.href, provider_name: `${source.name} · EmbedFix`, provider_url: url.origin });
      } else {
        headers.set("content-type", "text/html; charset=utf-8");
        let type = "article", card = "summary";
        if (media?.image) card = "summary_large_image";
        if (media?.video) { type = "video.other"; card = "player"; }
        if (source.name === "SoundCloud") type = original.pathname.includes("/sets/") ? "music.playlist" : "music.song";
        const tags: Record<string, string | number | undefined> = {
          "og:site_name": `${source.name} · EmbedFix`, "og:url": original.href, "og:type": type,
          "og:title": title, "og:description": text, "twitter:title": title, "twitter:description": text, "twitter:card": card,
          "og:image": media?.image, "twitter:image": media?.image,
          "og:image:width": media?.image ? media.width : undefined, "og:image:height": media?.image ? media.height : undefined,
        };
        if (media?.video) Object.assign(tags, {
          "og:video": media.video, "og:video:secure_url": media.video, "og:video:type": "video/mp4",
          "og:video:width": media.width, "og:video:height": media.height,
          "twitter:player:stream": media.video, "twitter:player:stream:content_type": "video/mp4",
          "twitter:player:width": media.width, "twitter:player:height": media.height,
        });
        const meta = Object.entries(tags).filter(([, value]) => value !== undefined).map(([name, value]) =>
          `<meta ${name.startsWith("twitter:") ? "name" : "property"}="${name}" content="${Bun.escapeHTML(String(value))}">`).join("\n");
        body = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${Bun.escapeHTML(title)}</title>
${meta}<link rel="canonical" href="${Bun.escapeHTML(original.href)}">
<link rel="alternate" type="application/json+oembed" href="${Bun.escapeHTML(`${url.origin}/oembed?url=${encodeURIComponent(url.href)}`)}"></head>
<body><a href="${Bun.escapeHTML(original.href)}">Open original</a><script>location.replace(document.querySelector('link[rel="canonical"]').href)</script></body></html>`;
      }
    }
  } catch (error) {
    status = error instanceof HttpError ? error.status : 502;
    body = error instanceof HttpError ? error.message : "Source unavailable.";
    headers.set("content-type", "text/plain; charset=utf-8");
    headers.set("cache-control", "no-store");
  }
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}
