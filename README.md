# EmbedFix

Dependency-free Bun embed server. Fetches directly from X, Instagram, and SoundCloud.

| Replace | With |
| --- | --- |
| `twitter.com/` or `x.com/` | `fx.purduehackers.com/t/` |
| `instagram.com/` | `fx.purduehackers.com/i/` |
| `soundcloud.com/` or `on.soundcloud.com/` | `fx.purduehackers.com/s/` |

Keep the remaining path. Crawlers get metadata; browsers open the original. `/` returns 404. SoundCloud embeds contain title, artist, and artwork; X/Instagram support images and MP4s.

Use `?media=2` to select media or `?direct=1` for its URL. Instagram's `img_index` and X's `/photo/2` or `/video/2` work too. Successful metadata is cached for five minutes; errors are not cached.

```sh
bun install
bun dev          # PORT defaults to 3000
bun run check
bun test
```

Deploy with `vercel` or import the repo using Vercel's Bun preset, then connect `fx.purduehackers.com`. No build step or secrets. The domain must be publicly accessible to chat crawlers.

Public posts only. Upstream restrictions and format changes can break fetching. No mosaics, polls, translations, stories, or audio player.

References: [InstaFix](https://github.com/Wikidepia/InstaFix), [FxTwitter](https://github.com/allnodes/FxTwitter), [soundcloud-og](https://github.com/MatthewStanciu/soundcloud-og), [react-tweet](https://github.com/vercel/react-tweet).
