# deed.page Publisher for EmDash

A sandboxed [EmDash CMS](https://emdashcms.com) plugin that publishes any post or page to its own permanent URL at `https://<name>.deed.page`, using the [deed.page](https://deed.page) publish API.

- **Publish** from the **deed.page** panel in the content editor. Pick a name; the page goes live in seconds.
- **Update** with one click, or automatically whenever the entry is saved while published.
- **Delete** from deed.page without touching the EmDash entry.
- **Admin page** (`Plugins → deed.page`) lists everything published.

The published page is plain, fast HTML: title, summary, and body (Portable Text paragraphs, headings, lists, quotes, links, images, code), with `rel="canonical"` pointing back to the original when the entry is public on your site.

No deed.page account is needed. The first publish creates a free deed.page owner token and stores it in the plugin's `token` setting, which EmDash encrypts with `EMDASH_ENCRYPTION_KEY`. (If the site has no encryption key, the token is kept in plugin state so it is not lost, and the admin page shows a warning.) To publish under an existing deed.page account, paste its `deed_tok_...` token into the plugin settings first.

## Permissions

| Capability | Why |
| --- | --- |
| `content:read` | Read the entry being published. |
| `network:request` (`deed.page` only) | Call `POST /v1/sites` and `DELETE /v1/sites/{slug}`. |

Nothing else leaves the site. See [docs/security.md](docs/security.md).

## Cost

The plugin is free (MIT). The deed.page free plan covers 25 sites and 60 publishes per hour. If deed.page returns a plan-limit error, the plugin shows deed.page's message as is and never buys anything.

## Develop

```sh
pnpm install
pnpm run validate     # manifest schema
pnpm run typecheck
pnpm run test         # unit tests + plugin run through EmDash's real sandbox (workerd), HTTP mocked
pnpm run e2e:live     # live check against deed.page: publish, update, delete a throwaway smoketest site
```

Layout:

- `src/plugin.ts`: routes (`admin` page, `editor/panel`), `content:afterSave` auto-update hook
- `src/deed.ts`: deed.page API client
- `src/render.ts`: entry → HTML (Portable Text renderer, page template)
- `emdash-plugin.jsonc`: registry manifest
- `docs/`: long-form listing sections

## Release

Releases go to the EmDash plugin registry from the account pinned as `publisher` in `emdash-plugin.jsonc`:

```sh
pnpm run release            # = scripts/publish.sh upskillcoach.bsky.social
pnpm run release --dry-run
```

The script checks the handle resolves to the pinned DID, runs typecheck and tests, signs in with atproto OAuth in a browser if this machine has no registry session, then runs `emdash-plugin publish`.

## License

MIT © Avatar 8 LLC. Security reports: ops@avatar33.com.
