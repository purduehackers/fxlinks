# fxlinks

Dependency-free Bun embed server. Fetches directly from X, Instagram, and SoundCloud.

| Replace | With |
| --- | --- |
| `twitter.com/` or `x.com/` | `fx.purduehackers.com/t/` |
| `instagram.com/` | `fx.purduehackers.com/i/` |
| `soundcloud.com/` or `on.soundcloud.com/` | `fx.purduehackers.com/s/` |

Keep the remaining path. Crawlers get metadata; browsers open the original. `/` returns 404.

X and Instagram use Discord post cards with author avatars, linked quotes/replies, media galleries, and dates when available. SoundCloud uses compact music cards with the artist's name, artwork thumbnail, short intro, waveform, duration, genre, plays, hearts, comments, and reposts. Other clients get Open Graph cards. Only counts exposed by the source appear: X's public endpoint usually omits post views and repost counts. Waveforms use the track's samples and fall back to a plain duration if unavailable.

Use `?media=2` to select media or `?direct=1` for its URL. Instagram's `img_index` and X's `/photo/2` or `/video/2` work too. Successful metadata is cached for five minutes; errors are not cached.

Each warm server instance shares upstream metadata across HTML, oEmbed, Discord status requests, and media selections. Concurrent requests for the same post share one fetch. The cache retains at most 128 posts and 2 MiB of serialized metadata; response cache headers use the remaining freshness so CDN caching does not extend the five-minute window. This needs no database or cache service, and cold instances fetch normally.

```sh
bun install
bun dev          # PORT defaults to 3000
bun run check
bun test
```

Deploy with `vercel` or import the repo using Vercel's Bun preset, then connect `fx.purduehackers.com`. No build step or secrets. The domain must be publicly accessible to chat crawlers.

Public posts only. Upstream restrictions and format changes can break fetching. No mosaics, polls, translations, stories, or audio player.

References: [InstaFix](https://github.com/Wikidepia/InstaFix), [FxTwitter](https://github.com/FxEmbed/FxEmbed), [soundcloud-og](https://github.com/MatthewStanciu/soundcloud-og), [react-tweet](https://github.com/vercel/react-tweet).
