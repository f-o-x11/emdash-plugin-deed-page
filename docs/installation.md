1. In the EmDash admin, open **Plugins**, find **deed.page Publisher**, and install it. Review the requested access: read content, and network requests to `deed.page` only.
2. Open any post or page. The **deed.page** panel appears in the editor sidebar.
3. Choose a name and click **Publish to deed.page**. The page goes live at `https://<name>.deed.page`.

To publish under an existing deed.page account, paste its `deed_tok_...` token into the plugin settings before the first publish.

Registry installs need a sandbox runner (Worker Loader on Cloudflare, or `@emdash-cms/sandbox-workerd` on Node.js). See the EmDash docs on installing plugins.
