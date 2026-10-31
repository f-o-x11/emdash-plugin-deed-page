#!/usr/bin/env node
/**
 * Live end-to-end check against the real deed.page API.
 *
 * Drives the built sandbox bundle (dist/plugin.mjs) through its editor-panel
 * route with an in-memory EmDash context: publish -> fetch the live page ->
 * edit + update -> fetch again -> delete -> confirm it is gone.
 *
 * Uses a throwaway `smoketest-...` slug and ref so deed.page counts it as a
 * test owner, and always deletes what it creates. The owner token is never
 * printed (only its prefix and length).
 *
 *   pnpm run build && node scripts/e2e-live.mjs
 */
import plugin from "../dist/plugin.mjs";

const rand = Math.random().toString(36).slice(2, 8);
const slug = `smoketest-emdash-${rand}`;
const collection = "posts";
const entryId = "01E2ETESTENTRY";

const entry = {
	id: entryId,
	type: collection,
	slug: "hello-from-emdash",
	status: "published",
	locale: "en",
	publishedAt: new Date().toISOString(),
	data: {
		title: "Hello from EmDash",
		excerpt: "Published by the deed.page plugin end-to-end test.",
		content: [
			{ _type: "block", _key: "a", style: "h2", children: [{ _type: "span", _key: "a1", text: "Section" }], markDefs: [] },
			{
				_type: "block",
				_key: "b",
				style: "normal",
				markDefs: [{ _key: "l", _type: "link", href: "https://deed.page" }],
				children: [
					{ _type: "span", _key: "b1", text: "Body text with a ", marks: [] },
					{ _type: "span", _key: "b2", text: "link", marks: ["l"] },
				],
			},
		],
	},
};

const mapStore = () => {
	const m = new Map();
	return {
		m,
		get: async (k) => (m.has(k) ? m.get(k) : null),
		set: async (k, v) => void m.set(k, v),
		delete: async (k) => m.delete(k),
	};
};
const settings = mapStore();
const kv = mapStore();
const sites = mapStore();

const calls = [];
const ctx = {
	plugin: { id: "deed-page", version: "0.1.0" },
	site: { name: "E2E Test Site", url: "https://emdash.example", locale: "en" },
	log: { info() {}, warn() {}, error() {}, debug() {} },
	settings: { get: settings.get, set: settings.set, delete: settings.delete },
	kv: { get: kv.get, set: kv.set, delete: kv.delete },
	storage: {
		sites: {
			get: sites.get,
			put: sites.set,
			delete: sites.delete,
			query: async () => ({ items: [...sites.m].map(([id, data]) => ({ id, data })) }),
		},
	},
	content: {
		get: async (c, id) => (c === collection && id === entryId ? entry : null),
		getPublicUrl: async () => "https://emdash.example/posts/hello-from-emdash",
	},
	http: {
		fetch: async (url, init) => {
			// Tag as a smoke test so it is excluded from deed.page stats.
			const tagged = url.replace("ref=emdash-plugin", "ref=emdash-plugin-smoketest");
			const res = await fetch(tagged, init);
			calls.push({ method: init?.method ?? "GET", url: tagged, status: res.status, auth: Boolean(init?.headers?.authorization) });
			return res;
		},
	},
};

const panel = (input) =>
	plugin.routes["editor/panel"].handler(
		{ input, ui: { surface: "content-editor-panel", entry: { collection, id: entryId, locale: "en", version: 1 }, extensionId: "deed-page" } },
		ctx,
	);

const ok = (cond, msg) => {
	if (!cond) throw new Error(`FAIL: ${msg}`);
	console.log(`ok  - ${msg}`);
};
const page = async (url) => {
	const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
	return { status: res.status, text: await res.text() };
};

let published = false;
try {
	const load = await panel({ type: "panel_load" });
	ok(load.blocks.some((b) => b.type === "form"), "panel offers a publish form");

	const pub = await panel({ type: "form_submit", action_id: "publish", values: { slug } });
	ok(pub.toast?.type === "success", `publish toast: ${pub.toast?.message}`);
	published = true;
	const token = await settings.get("token");
	ok(typeof token === "string" && token.startsWith("deed_tok_"), `token minted and stored (deed_tok_..., ${token.length} chars, not shown)`);
	const rec = await sites.get(`${collection}:${entryId}`);
	ok(rec?.url === `https://${slug}.deed.page/`, `record url ${rec?.url} version ${rec?.version}`);

	const live1 = await page(rec.url);
	ok(live1.status === 200 && live1.text.includes("<h1>Hello from EmDash</h1>"), `GET ${rec.url} -> ${live1.status}, title rendered`);
	ok(live1.text.includes('rel="canonical" href="https://emdash.example/posts/hello-from-emdash"'), "canonical link present");

	entry.data.title = "Hello again from EmDash";
	const upd = await panel({ type: "block_action", action_id: "update" });
	ok(upd.toast?.type === "success", `update toast: ${upd.toast?.message}`);
	const rec2 = await sites.get(`${collection}:${entryId}`);
	ok(rec2.version !== rec.version, `version changed ${rec.version} -> ${rec2.version}`);
	let live2;
	for (let i = 0; i < 5; i++) {
		live2 = await page(`${rec.url}?v=${Date.now()}`);
		if (live2.text.includes("Hello again from EmDash")) break;
		await new Promise((r) => setTimeout(r, 1500));
	}
	ok(live2.text.includes("<h1>Hello again from EmDash</h1>"), `GET ${rec.url} -> ${live2.status}, updated title live`);

	const del = await panel({ type: "block_action", action_id: "unpublish" });
	ok(del.toast?.type === "success", `delete toast: ${del.toast?.message}`);
	published = false;
	ok((await sites.get(`${collection}:${entryId}`)) === null, "local record removed");
	let gone;
	for (let i = 0; i < 5; i++) {
		gone = await page(`${rec.url}?v=${Date.now()}`);
		if (gone.status >= 400) break;
		await new Promise((r) => setTimeout(r, 1500));
	}
	ok(gone.status >= 400, `GET ${rec.url} after delete -> ${gone.status}`);
} finally {
	if (published) {
		const token = await settings.get("token");
		if (token) {
			const r = await fetch(`https://deed.page/v1/sites/${slug}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
			console.log(`cleanup DELETE ${slug} -> ${r.status}`);
		}
	}
	console.log("API calls:");
	for (const c of calls) console.log(`  ${c.method} ${c.url} -> ${c.status}${c.auth ? " (Bearer)" : ""}`);
}
