import { embed, type Post } from "./embed.ts";

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Data = Record<string, any>;
class HttpError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const sources = {
  t: { name: "X", origin: "https://x.com", color: "#1d9bf0", cdns: ["twimg.com"],
    path: /^\/(?:\w{1,15}|i\/web)\/status\/(\d{1,25})(?:\/(?:photo|video)\/(\d+))?\/?$/ },
  i: { name: "Instagram", origin: "https://www.instagram.com", color: "#e1306c", cdns: ["cdninstagram.com", "fbcdn.net"],
    path: /^\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,32})(?:\/(\d+))?\/?$/ },
  s: { name: "SoundCloud", origin: "https://soundcloud.com", color: "#ff5500", cdns: ["sndcdn.com"],
    path: /^\/(?:[\w-]{1,200}\/(?:sets\/)?[\w-]{1,200}|[a-zA-Z0-9]{4,100})\/?$/ },
};
const list = (value: unknown): Data[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object") : [];
const dimension = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
function count(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
}
const excerpt = (value: string, limit = 3000) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
function date(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return;
  const time = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isFinite(time.getTime())) return time.toISOString();
}

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

async function read(url: string | URL, fetcher: Fetcher, timeout = 10_000): Promise<string> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(timeout),
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

function instagramPost(data: Data, original: string): Post {
  const user = data.owner ?? data.user;
  if (typeof user?.username !== "string" || !user.username) throw new HttpError("Invalid Instagram response.");
  const media = list(data.edge_sidecar_to_children?.edges?.map((e: Data) => e?.node) ?? data.carousel_media ?? [data]).slice(0, 20).map(item => {
    const imageData = bestMedia(item.image_versions2?.candidates, sources.i.cdns);
    const image = mediaURL(item.display_url || imageData?.url, sources.i.cdns);
    const video = mediaURL(item.video_url || bestMedia(item.video_versions, sources.i.cdns)?.url, sources.i.cdns);
    const isVideo = item.is_video === true || item.media_type === 2 || /Video/.test(item.__typename) || !!item.video_url || !!video;
    if (isVideo && !video || !isVideo && !image) throw new HttpError("Instagram media unavailable or requires login.");
    return { image, video, alt: item.accessibility_caption, width: dimension(item.dimensions?.width ?? item.original_width ?? imageData?.width),
      height: dimension(item.dimensions?.height ?? item.original_height ?? imageData?.height) };
  });
  if (!media.length) throw new HttpError("Instagram returned no media.");
  return { author: { name: user.full_name || user.username, handle: user.username,
      url: `${sources.i.origin}/${encodeURIComponent(user.username)}/`, avatar: mediaURL(user.profile_pic_url, sources.i.cdns) },
    text: data.edge_media_to_caption?.edges?.[0]?.node?.text ?? data.caption?.text ?? "", media, original,
    date: date(data.taken_at_timestamp ?? data.taken_at),
    stats: { likes: count(data.edge_liked_by?.count ?? data.edge_media_preview_like?.count ?? data.like_count),
      replies: count(data.edge_media_to_comment?.count ?? data.edge_media_to_parent_comment?.count ?? data.comment_count),
      views: count(data.video_view_count ?? data.play_count ?? data.video_play_count) } };
}

function twitterPost(data: Data, quoted = false): Post {
  if (!data.user?.screen_name || typeof data.text !== "string" || !/^\d+$/.test(data.id_str)) throw new HttpError("Invalid X response.");
  const user = data.user;
  let text: string = data.note_tweet?.text || data.text;
  for (const entity of list(data.entities?.urls)) {
    if (entity.url && entity.expanded_url) text = text.replaceAll(entity.url, entity.expanded_url);
  }
  for (const entity of list(data.entities?.media)) {
    if (entity.url) text = text.replaceAll(entity.url, "");
  }
  const quote = !quoted && data.quoted_tweet?.user ? twitterPost(data.quoted_tweet, true) : undefined;
  if (quote) text = text.replace(new RegExp(`https?://(?:www\\.)?(?:twitter|x)\\.com/\\w+/status/${data.quoted_tweet.id_str}\\b\\S*`, "g"), "");
  text = text.replace(/&(amp|lt|gt);/g, (_, key: string) => ({ amp: "&", lt: "<", gt: ">" })[key]!);
  const media = list(data.mediaDetails).slice(0, 20).map(item => {
    const image = mediaURL(item.media_url_https, sources.t.cdns);
    const video = mediaURL(bestMedia(item.video_info?.variants, sources.t.cdns, "video/mp4")?.url, sources.t.cdns);
    const isVideo = ["video", "animated_gif"].includes(item.type);
    if (isVideo && !video || !isVideo && (item.type !== "photo" || !image)) throw new HttpError("Media unavailable.");
    return { image, video, alt: item.ext_alt_text, width: dimension(item.original_info?.width), height: dimension(item.original_info?.height) };
  });
  const profile = `${sources.t.origin}/${encodeURIComponent(user.screen_name)}`;
  return { author: { name: user.name || user.screen_name, handle: user.screen_name, url: profile,
      avatar: mediaURL(user.profile_image_url_https, sources.t.cdns) },
    text: excerpt(text.trim(), quoted ? 1500 : 3000), original: `${profile}/status/${data.id_str}`, date: date(data.created_at),
    quote, replyingTo: data.in_reply_to_screen_name, media: media.length ? media : quote?.media ?? [],
    stats: { likes: count(data.favorite_count), replies: count(data.conversation_count ?? data.reply_count),
      reposts: count(data.retweet_count), quotes: count(data.quote_count), views: count(data.view_count ?? data.views?.count),
      plays: count(data.video?.viewCount) } };
}

async function soundcloudWaveform(value: unknown, fetcher: Fetcher): Promise<string> {
  const url = mediaURL(value, sources.s.cdns);
  if (!url) return "";
  try {
    const { samples } = JSON.parse(await read(url, fetcher, 2000));
    const bars = 8;
    if (!Array.isArray(samples) || samples.length < bars ||
        !samples.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000)) return "";
    const levels = Array.from({ length: bars }, (_, index) => {
      const chunk = samples.slice(Math.floor(index * samples.length / bars), Math.floor((index + 1) * samples.length / bars));
      return chunk.reduce((sum, sample) => sum + sample, 0) / chunk.length;
    });
    const low = Math.min(...levels), range = Math.max(...levels) - low || 1;
    return levels.map(level => "·∣❘|│"[Math.round((level - low) / range * 4)]).join("");
  } catch { return ""; }
}

async function soundcloudPost(original: URL, fetcher: Fetcher): Promise<Post> {
  try {
    const html = await read(original, fetcher);
    const hydration = html.match(/window\.__sc_hydration\s*=\s*([\s\S]*?);\s*<\/script>/)?.[1];
    const data = list(JSON.parse(hydration ?? "[]")).find(item => ["sound", "playlist"].includes(item.hydratable))?.data;
    if (typeof data?.title !== "string" || !data.title || typeof data.user?.username !== "string" ||
        typeof data.user.permalink !== "string") throw new HttpError("Invalid SoundCloud response.");
    const duration = dimension(data.full_duration ?? data.duration);
    let length: string | undefined;
    if (duration) {
      const seconds = Math.floor(duration / 1000);
      const parts = [Math.floor(seconds / 60) % 60, seconds % 60];
      if (seconds >= 3600) parts.unshift(Math.floor(seconds / 3600));
      length = parts.map((part, index) => index ? String(part).padStart(2, "0") : part).join(":");
    }
    const waveform = length ? await soundcloudWaveform(data.waveform_url, fetcher) : "";
    const image = mediaURL(data.artwork_url || list(data.tracks).find(track => track.artwork_url)?.artwork_url || data.user.avatar_url, sources.s.cdns)
      ?.replace(/-large\.(jpg|png|webp)$/, "-t500x500.$1");
    return { title: data.title, text: excerpt((data.description || "").trim().split(/\r?\n/, 1)[0]!, 140), original: original.href,
      author: { name: data.user.username, handle: data.user.permalink, url: `${sources.s.origin}/${encodeURIComponent(data.user.permalink)}`,
        avatar: mediaURL(data.user.avatar_url, sources.s.cdns) },
      media: image ? [{ image }] : [], date: date(data.display_date ?? data.created_at),
      details: [length && ["▶", waveform, length].filter(Boolean).join(" "), data.kind === "playlist" && count(data.track_count) !== undefined && `${data.track_count} tracks`, data.genre].filter(Boolean).join(" · "),
      stats: { likes: count(data.likes_count), replies: count(data.comment_count), reposts: count(data.reposts_count), plays: count(data.playback_count) } };
  } catch {
    const data = JSON.parse(await read(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(original.href)}`, fetcher));
    if (typeof data?.title !== "string" || !data.title || typeof data.author_name !== "string" || !data.author_name) throw new HttpError("Invalid SoundCloud response.");
    const image = mediaURL(data.thumbnail_url, sources.s.cdns);
    const handle = original.pathname.split("/")[1]!;
    return { title: data.title, text: `By ${data.author_name}`, original: original.href,
      author: { name: data.author_name, handle, url: `${sources.s.origin}/${handle}` }, media: image ? [{ image }] : [], stats: {} };
  }
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
  let post: Post;

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
    post = await soundcloudPost(original, fetcher);
  } else if (key === "t") {
    const token = (Number(match[1]) / 1e15 * Math.PI).toString(36).replace(/[0.]/g, "");
    const data = JSON.parse(await read(`https://cdn.syndication.twimg.com/tweet-result?id=${match[1]}&lang=en&token=${token}`, fetcher));
    if (!data || data.__typename === "TweetTombstone" || !Object.keys(data).length) throw new HttpError("Post unavailable.", 404);
    if (data.id_str !== match[1]) throw new HttpError("Invalid X response.");
    post = twitterPost(data);
  } else {
    let found: Post | undefined, failure: unknown;
    for (const suffix of ["embed/captioned/", ""]) {
      try {
        const data = instagramData(await read(`https://www.instagram.com/p/${match[1]}/${suffix}`, fetcher), match[1]!);
        if (data) { found = instagramPost(data, original.href); break; }
      } catch (error) { failure = error; }
    }
    if (!found) throw failure ?? new HttpError("Instagram post unavailable.");
    post = found;
  }
  if ((selection !== undefined || url.searchParams.get("direct") === "1") && !post.media[index]) throw new HttpError("Media not found.", 404);
  if (selection !== undefined) post.media = [post.media[index]!];
  post.text = excerpt(post.text.trim());
  const pathWithSelection = url.pathname + (selection === undefined ? "" : `?media=${selection}`);
  // Discord's Mastodon discovery requires a numeric ID; encode the local route without server-side state.
  const id = BigInt(`0x${Buffer.from(pathWithSelection).toString("hex")}`).toString();
  return { post, source, id };
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
    const activity = /^\/(?:api\/v1\/statuses|users\/[\w.-]+\/statuses)\/(\d{1,2500})$/.exec(url.pathname);
    let target = url;
    if (isOembed) {
      try { target = new URL(url.searchParams.get("url") ?? ""); } catch { throw new HttpError("Invalid embed URL.", 400); }
      if (target.origin !== url.origin) throw new HttpError("Invalid embed origin.", 400);
    }
    if (activity) {
      const hex = BigInt(activity[1]!).toString(16);
      const path = Buffer.from(hex.padStart(hex.length + hex.length % 2, "0"), "hex").toString();
      if (!/^\/[tis]\//.test(path)) throw new HttpError("Invalid status ID.", 400);
      target = new URL(path, url.origin);
    }
    const { post, source, id } = await loadPost(target, fetcher);
    const media = post.media[0];
    if (!isOembed && !activity && url.searchParams.get("direct") === "1") {
      status = 302;
      headers.set("location", (media?.video || media?.image)!);
    } else {
      headers.set("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=30");
      const rendered = embed(post, source, target, id);
      if (isOembed || activity) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(activity ? rendered.activity : rendered.oembed);
      } else {
        headers.set("content-type", "text/html; charset=utf-8");
        body = rendered.html;
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
