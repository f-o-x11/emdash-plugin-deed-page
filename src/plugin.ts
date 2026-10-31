/**
 * deed.page publisher for EmDash.
 *
 * Adds a "deed.page" panel to the content editor. One click publishes the
 * saved entry as a standalone page at https://<name>.deed.page. The first
 * publish mints a deed.page owner token, which is stored in the plugin's
 * encrypted `token` setting and reused for updates and deletes.
 *
 * Network access is limited to deed.page (see `allowedHosts` in the manifest).
 */
import type { BlockResponse } from "@emdash-cms/blocks";
import type { PluginContext, SandboxedPlugin } from "emdash/plugin";

import { deleteSite, isValidSlug, publishSite, suggestSlug, type FetchFn } from "./deed.js";
import { entryTitle, renderPage } from "./render.js";

export interface SiteRecord {
	collection: string;
	entryId: string;
	title: string;
	deedSlug: string;
	url: string;
	version: string;
	publishedAt: string;
	updatedAt: string;
}

export type Outcome =
	| { ok: true; record: SiteRecord; created: boolean }
	| { ok: false; message: string; code?: string };

const SITES = "sites";
const recordId = (collection: string, entryId: string) => `${collection}:${entryId}`;

function fetcher(ctx: PluginContext): FetchFn {
	if (!ctx.http) throw new Error("network:request capability is missing");
	const http = ctx.http;
	return (url, init) => http.fetch(url, init);
}

const FALLBACK_TOKEN_KEY = "state:token";

async function getToken(ctx: PluginContext): Promise<string | null> {
	const token = await ctx.settings.get<string>("token").catch(() => null);
	if (typeof token === "string" && token.trim()) return token.trim();
	const fallback = await ctx.kv.get<string>(FALLBACK_TOKEN_KEY);
	return typeof fallback === "string" && fallback ? fallback : null;
}

/**
 * Saves a freshly minted token. deed.page shows it only once, so it must not
 * be lost: when the site has no EMDASH_ENCRYPTION_KEY (secret settings cannot
 * be written), it is kept in plugin state instead and the admin page says so.
 */
async function saveToken(ctx: PluginContext, token: string): Promise<void> {
	try {
		await ctx.settings.set("token", token);
		await ctx.kv.delete(FALLBACK_TOKEN_KEY);
	} catch {
		await ctx.kv.set(FALLBACK_TOKEN_KEY, token);
		ctx.log.warn("deed.page token saved unencrypted in plugin state; set EMDASH_ENCRYPTION_KEY");
	}
}

export async function getRecord(
	ctx: PluginContext,
	collection: string,
	entryId: string,
): Promise<SiteRecord | null> {
	return (await ctx.storage[SITES]!.get(recordId(collection, entryId))) as SiteRecord | null;
}

/** Publishes (or republishes) one entry. Creates the deed.page site on first use. */
export async function publishEntry(
	ctx: PluginContext,
	collection: string,
	entryId: string,
	requestedSlug?: string,
): Promise<Outcome> {
	const entry = await ctx.content?.get(collection, entryId);
	if (!entry) return { ok: false, message: "Entry not found. Save it first." };

	const existing = await getRecord(ctx, collection, entryId);
	const slug = existing?.deedSlug ?? (requestedSlug ?? "").trim().toLowerCase();
	if (!isValidSlug(slug)) {
		return {
			ok: false,
			message: "Pick a name of 1-63 lowercase letters, digits, or hyphens.",
		};
	}

	let canonicalUrl: string | null = null;
	if (entry.status === "published" && ctx.content?.getPublicUrl) {
		canonicalUrl = await ctx.content.getPublicUrl(collection, entryId).catch(() => null);
		if (canonicalUrl && ctx.site.url && !/^https?:/.test(canonicalUrl)) {
			canonicalUrl = new URL(canonicalUrl, ctx.site.url).href;
		}
	}

	const html = renderPage({
		data: entry.data ?? {},
		slug: entry.slug,
		siteName: ctx.site.name,
		siteUrl: ctx.site.url,
		canonicalUrl,
		lang: entry.locale ?? ctx.site.locale,
		publishedAt: entry.publishedAt,
	});

	const token = await getToken(ctx);
	const result = await publishSite(fetcher(ctx), { slug, html, token });

	if (!result.ok) {
		if (result.token && !token) await saveToken(ctx, result.token);
		ctx.log.warn("deed.page publish failed", { status: result.status, code: result.code });
		return { ok: false, message: result.message, code: result.code };
	}
	if (result.token && !token) {
		// Shown once by deed.page. Never logged or rendered.
		await saveToken(ctx, result.token);
	}

	const now = new Date().toISOString();
	const record: SiteRecord = {
		collection,
		entryId,
		title: entryTitle(entry.data ?? {}, entry.slug),
		deedSlug: result.slug,
		url: result.url,
		version: result.version,
		publishedAt: existing?.publishedAt ?? now,
		updatedAt: now,
	};
	await ctx.storage[SITES]!.put(recordId(collection, entryId), record);
	ctx.log.info("published to deed.page", { url: result.url, version: result.version });
	return { ok: true, record, created: !existing };
}

/** Deletes the deed.page site for an entry and forgets it. */
export async function unpublishEntry(
	ctx: PluginContext,
	collection: string,
	entryId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const existing = await getRecord(ctx, collection, entryId);
	if (!existing) return { ok: true };
	const token = await getToken(ctx);
	if (!token) {
		return { ok: false, message: "No deed.page token is saved, so the site cannot be deleted." };
	}
	const result = await deleteSite(fetcher(ctx), { slug: existing.deedSlug, token });
	if (!result.ok) return { ok: false, message: result.message };
	await ctx.storage[SITES]!.delete(recordId(collection, entryId));
	return { ok: true };
}

// ── Block Kit UI ─────────────────────────────────────────────────────────────

async function panelBlocks(
	ctx: PluginContext,
	collection: string,
	entryId: string,
): Promise<BlockResponse["blocks"]> {
	const record = await getRecord(ctx, collection, entryId);
	if (record) {
		return [
			{
				type: "fields",
				fields: [
					{ label: "Live at", value: record.url },
					{ label: "Version", value: record.version || "-" },
					{ label: "Last published", value: record.updatedAt.slice(0, 16).replace("T", " ") },
				],
			},
			{
				type: "actions",
				elements: [
					{ type: "button", action_id: "update", label: "Update", style: "primary" },
					{
						type: "link",
						label: "Open",
						target: { kind: "external", url: record.url },
						appearance: "secondary",
					},
					{
						type: "button",
						action_id: "unpublish",
						label: "Delete from deed.page",
						style: "danger",
						confirm: {
							title: "Delete this deed.page site?",
							text: `${record.url} will stop working. The EmDash entry is not touched.`,
							confirm: "Delete",
							deny: "Cancel",
							style: "danger",
						},
					},
				],
			},
			{ type: "context", text: "Update republishes the saved version of this entry." },
		];
	}
	const entry = await ctx.content?.get(collection, entryId);
	const blocks: BlockResponse["blocks"] = [
		{
			type: "section",
			text: "Publish the saved version of this entry as its own page at https://<name>.deed.page.",
		},
	];
	if (entry && entry.status !== "published") {
		blocks.push({
			type: "banner",
			variant: "alert",
			description: "This entry is not published on your site yet. The deed.page copy is public.",
		});
	}
	blocks.push({
		type: "form",
		fields: [
			{
				type: "text_input",
				action_id: "slug",
				label: "Name (becomes <name>.deed.page)",
				initial_value: suggestSlug(entry?.slug ?? entryTitle(entry?.data ?? {})),
			},
		],
		submit: { label: "Publish to deed.page", action_id: "publish" },
	});
	return blocks;
}

async function adminPage(ctx: PluginContext): Promise<BlockResponse> {
	const result = await ctx.storage[SITES]!.query({ orderBy: { updatedAt: "desc" }, limit: 100 });
	const hasToken = (await getToken(ctx)) !== null;
	const unencrypted = (await ctx.kv.get<string>(FALLBACK_TOKEN_KEY)) !== null;
	return {
		blocks: [
			{ type: "header", text: "deed.page" },
			{
				type: "section",
				text: "Entries published to deed.page from the content editor. Open an entry and use the deed.page panel to publish, update, or delete.",
			},
			{
				type: "table",
				page_action_id: "sites_page",
				empty_text: "Nothing published yet.",
				columns: [
					{ key: "title", label: "Entry" },
					{ key: "url", label: "URL", format: "code" },
					{ key: "version", label: "Version" },
					{ key: "updatedAt", label: "Updated", format: "relative_time" },
				],
				rows: result.items.map(({ data }) => {
					const r = data as SiteRecord;
					return { title: r.title, url: r.url, version: r.version, updatedAt: r.updatedAt };
				}),
			},
			...(unencrypted
				? [
						{
							type: "banner" as const,
							variant: "alert" as const,
							title: "Token is not encrypted",
							description:
								"This site has no EMDASH_ENCRYPTION_KEY, so the deed.page token is kept in plain plugin state. Set the key, then paste the token into Settings.",
						},
					]
				: []),
			{
				type: "context",
				text: hasToken
					? "A deed.page owner token is saved (encrypted). Keep a copy: it is the only way to manage these sites outside EmDash."
					: "No deed.page token yet. The first publish creates one and saves it here, or paste an existing token in Settings.",
			},
			{
				type: "actions",
				elements: [
					{ type: "link", label: "Settings", target: { kind: "plugin-settings" } },
					{
						type: "link",
						label: "deed.page docs",
						target: { kind: "external", url: "https://deed.page/docs" },
					},
				],
			},
		],
	};
}

interface Interaction {
	type?: string;
	page?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterSave": {
			timeout: 20000,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const auto = await ctx.settings.get<boolean>("autoUpdate");
				if (auto === false) return;
				if (event.content.status !== "published") return;
				const id = String(event.content.id);
				if (!(await getRecord(ctx, event.collection, id))) return;
				const out = await publishEntry(ctx, event.collection, id);
				if (!out.ok) ctx.log.warn("deed.page auto-update failed", { code: out.code });
			},
		},
	},
	routes: {
		admin: {
			handler: async (routeCtx, ctx) => {
				const input = (routeCtx.input ?? {}) as Interaction;
				if (input.type === "page_load" && input.page === "/sites") return adminPage(ctx);
				return { blocks: [] };
			},
		},
		"editor/panel": {
			handler: async (routeCtx, ctx): Promise<BlockResponse> => {
				const entry = routeCtx.ui?.entry;
				if (!entry) return { blocks: [] };
				const input = (routeCtx.input ?? {}) as Interaction;
				const { collection, id } = entry;

				if (input.type === "form_submit" && input.action_id === "publish") {
					const slug = typeof input.values?.slug === "string" ? input.values.slug : "";
					const out = await publishEntry(ctx, collection, id, slug);
					return {
						blocks: await panelBlocks(ctx, collection, id),
						toast: out.ok
							? { type: "success", message: `Live at ${out.record.url}` }
							: { type: "error", message: out.message },
					};
				}
				if (input.type === "block_action" && input.action_id === "update") {
					const out = await publishEntry(ctx, collection, id);
					return {
						blocks: await panelBlocks(ctx, collection, id),
						toast: out.ok
							? { type: "success", message: `Updated ${out.record.url}` }
							: { type: "error", message: out.message },
					};
				}
				if (input.type === "block_action" && input.action_id === "unpublish") {
					const out = await unpublishEntry(ctx, collection, id);
					return {
						blocks: await panelBlocks(ctx, collection, id),
						toast: out.ok
							? { type: "success", message: "Deleted from deed.page" }
							: { type: "error", message: out.message },
					};
				}
				return { blocks: await panelBlocks(ctx, collection, id) };
			},
		},
	},
};

export default plugin;
