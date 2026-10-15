export type Media = { image?: string; video?: string; width?: number; height?: number; alt?: string };
export type Post = {
  author: { name: string; handle: string; url: string; avatar?: string };
  text: string; media: Media[]; original: string; title?: string; date?: string; details?: string;
  stats: Partial<Record<"likes" | "replies" | "reposts" | "quotes" | "views" | "plays", number>>;
  quote?: Post; replyingTo?: string;
};
type Source = { name: string; origin: string; color: string };
const escape = Bun.escapeHTML;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const icons = { likes: "❤️", replies: "💬", reposts: "🔁", quotes: "❞", views: "👁️", plays: "▶" };

function linkedText(text: string, source: Source): string {
  return text.split(/(https?:\/\/[^\s<>"]+|(?<![\w@])@[\w.]{1,30}|(?<![\w&])#[\p{L}\p{N}_]+)/gu).map((part, index) => {
    if (index % 2 === 0) return escape(part);
    let href = part;
    if (part.startsWith("@")) href = `${source.origin}/${encodeURIComponent(part.slice(1))}`;
    if (part.startsWith("#")) {
      let path = "tags";
      if (source.name === "X") path = "hashtag";
      if (source.name === "Instagram") path = "explore/tags";
      href = `${source.origin}/${path}/${encodeURIComponent(part.slice(1))}`;
    }
    return `<a href="${escape(href)}">${escape(part)}</a>`;
  }).join("").replaceAll("\n", "<br>");
}

export function embed(post: Post, source: Source, url: URL, id: string) {
  const isSoundCloud = source.name === "SoundCloud";
  const author = isSoundCloud ? post.author.name : `${post.author.name} (@${post.author.handle})`;
  const title = post.title || author;
  const stats = Object.entries(post.stats).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${icons[key as keyof typeof icons]} ${compact.format(value!)}`).join("   ");
  const quote = post.quote;
  const description = [post.details, isSoundCloud && stats, post.text, quote && `Quoting ${quote.author.name} (@${quote.author.handle})\n${quote.text}`, !isSoundCloud && stats]
    .filter(Boolean).join(isSoundCloud ? "\n" : "\n\n");
  let content = linkedText(post.text, source);
  if (post.details) content = `${escape(post.details)}<br><br>${content}`;
  if (post.title) content = `<b><a href="${escape(post.original)}">${escape(post.title)}</a></b><br><br>${content}`;
  if (post.replyingTo) content = `<small>↩ Replying to <a href="${source.origin}/${escape(post.replyingTo)}">@${escape(post.replyingTo)}</a></small><br><br>${content}`;
  if (quote) content += `<br><br><blockquote><b><a href="${escape(quote.original)}">Quoting ${escape(quote.author.name)}</a> (<a href="${escape(quote.author.url)}">@${escape(quote.author.handle)}</a>)</b><br><br>${linkedText(quote.text, source)}</blockquote>`;
  if (stats) content += `<br><br><b>${stats}</b>`;
  const activity = {
    id, url: post.original, uri: post.original, created_at: post.date ?? null, edited_at: null,
    content, visibility: "public", sensitive: false, spoiler_text: "", reblog: null,
    in_reply_to_id: null, in_reply_to_account_id: null, language: null,
    favourites_count: post.stats.likes, replies_count: post.stats.replies, reblogs_count: post.stats.reposts,
    application: { name: source.name, website: source.origin },
    account: { id: post.author.handle, username: post.author.handle, acct: post.author.handle,
      display_name: post.author.name, url: post.author.url, uri: post.author.url,
      avatar: post.author.avatar, avatar_static: post.author.avatar, locked: false, bot: false, emojis: [], fields: [] },
    media_attachments: post.media.map((media, index) => ({
      id: String(index + 1), type: media.video ? "video" : "image", url: media.video || media.image,
      preview_url: media.image, remote_url: null, preview_remote_url: null, text_url: null, description: media.alt ?? null,
      meta: { original: { width: media.width, height: media.height } },
    })),
    mentions: [], tags: [], emojis: [], card: null, poll: null,
  };
  const oembed = { version: "1.0", type: "link", title,
    author_name: post.author.name, author_url: post.author.url, provider_name: source.name, provider_url: source.origin };
  const media = post.media[0];
  let type = "article", card = "summary";
  let image = media?.image || post.author.avatar;
  if (media?.image) card = "summary_large_image";
  if (media?.video) { type = "video.other"; card = "player"; }
  if (isSoundCloud) {
    type = post.original.includes("/sets/") ? "music.playlist" : "music.song";
    card = "summary";
    image = image?.replace(/-t500x500\.(jpg|png|webp)$/, "-large.$1");
  }
  const tags: Record<string, string | number | undefined> = {
    "og:site_name": source.name, "og:url": post.original, "og:type": type, "theme-color": source.color,
    "og:title": title, "og:description": description, "twitter:title": title, "twitter:description": description, "twitter:card": card,
    "og:image": image, "twitter:image": image,
    "og:image:width": media?.image ? media.width : undefined, "og:image:height": media?.image ? media.height : undefined,
    "article:published_time": post.date, "article:author": post.author.url,
  };
  if (media?.video) Object.assign(tags, {
    "og:video": media.video, "og:video:secure_url": media.video, "og:video:type": "video/mp4",
    "og:video:width": media.width, "og:video:height": media.height,
    "twitter:player:stream": media.video, "twitter:player:stream:content_type": "video/mp4",
    "twitter:player:width": media.width, "twitter:player:height": media.height,
  });
  const meta = Object.entries(tags).filter(([, value]) => value !== undefined).map(([name, value]) =>
    `<meta ${name.startsWith("twitter:") || name === "theme-color" ? "name" : "property"}="${name}" content="${escape(String(value))}">`).join("\n");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escape(title)}</title>
${meta}<link rel="canonical" href="${escape(post.original)}">
<link rel="icon" href="${source.origin}/favicon.ico">
${isSoundCloud ? "" : `<link rel="alternate" type="application/activity+json" href="${url.origin}/users/${encodeURIComponent(post.author.handle)}/statuses/${id}">`}
<link rel="alternate" type="application/json+oembed" href="${escape(`${url.origin}/oembed?url=${encodeURIComponent(url.href)}`)}"></head>
<body><a href="${escape(post.original)}">Open original</a><script>location.replace(document.querySelector('link[rel="canonical"]').href)</script></body></html>`;
  return { html, activity, oembed };
}
