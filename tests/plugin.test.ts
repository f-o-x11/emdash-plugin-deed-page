import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

const PUBLISH_URL = "https://deed.page/v1/sites?ref=emdash-plugin";
const FAKE_TOKEN = "deed_tok_test_only_not_real";

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
	vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function setup(encryptionKey = true) {
	if (encryptionKey) {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	}
	host = await createPluginRuntimeTestHost({
		site: { name: "Test Site", url: "https://site.example", locale: "en" },
	});
	const admin = await host.fixtures.user({ email: "admin@example.com", role: "admin" });
	await host.fixtures.collection({
		slug: "posts",
		label: "Posts",
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "content", label: "Content", type: "portableText" },
		],
	});
	const post = await host.fixtures.content("posts", {
		slug: "hello-world",
		status: "published",
		data: {
			title: "Hello World",
			content: [
				{
					_type: "block",
					_key: "b1",
					style: "normal",
					children: [{ _type: "span", _key: "s1", text: "First paragraph.", marks: [] }],
					markDefs: [],
				},
			],
		},
	});
	return { host, admin, post };
}

describe("deed.page editor panel", () => {
	it("publishes, updates and deletes through the sandbox", async () => {
		const { host, admin, post } = await setup();

		const initial = await host.admin.loadEditorPanel("deed-page", "posts", post.id, { user: admin });
		const form = initial.blocks.find((b) => b.type === "form");
		expect(form).toBeDefined();

		// First publish: no token yet, deed.page mints one.
		await host.http.respond(
			PUBLISH_URL,
			json(
				{
					ok: true,
					url: "https://hello-world-ab12.deed.page/",
					slug: "hello-world-ab12",
					version: "v1",
					token: FAKE_TOKEN,
				},
				201,
			),
		);
		const published = await host.admin.submitEditorPanel(
			"deed-page",
			"posts",
			post.id,
			"publish",
			{ slug: "hello-world-ab12" },
			{ user: admin },
		);
		expect(published.toast).toEqual({
			type: "success",
			message: "Live at https://hello-world-ab12.deed.page/",
		});

		const [first] = host.http.requests();
		expect(first?.method).toBe("POST");
		expect(first?.headers.authorization).toBeUndefined();
		const body = JSON.parse(new TextDecoder().decode(first!.body)) as {
			slug: string;
			files: Record<string, string>;
		};
		expect(body.slug).toBe("hello-world-ab12");
		expect(body.files["index.html"]).toContain("<h1>Hello World</h1>");
		expect(body.files["index.html"]).toContain("<p>First paragraph.</p>");

		// Token is stored as an encrypted setting, not in plain KV/storage.
		const raw = await host.inspect.settings.raw("token");
		expect(raw).toMatchObject({ $emdash: "plugin-setting" });
		expect(JSON.stringify(raw)).not.toContain(FAKE_TOKEN);
		expect(await host.inspect.kv.get("state:token")).toBeNull();
		const stored = await host.inspect.storage.list("sites");
		expect(stored).toHaveLength(1);
		expect(JSON.stringify(stored)).not.toContain(FAKE_TOKEN);
		expect(stored[0]?.data).toMatchObject({ deedSlug: "hello-world-ab12", version: "v1" });

		// Update reuses the slug and sends the token.
		host.http.clear();
		await host.http.respond(
			PUBLISH_URL,
			json({ ok: true, url: "https://hello-world-ab12.deed.page/", slug: "hello-world-ab12", version: "v2" }),
		);
		const updated = await host.admin.actEditorPanel("deed-page", "posts", post.id, "update", {
			user: admin,
		});
		expect(updated.toast?.type).toBe("success");
		expect(host.http.requests()[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);

		// Admin page lists the site.
		const page = await host.admin.loadPage("/sites", { user: admin });
		const table = page.blocks.find((b) => b.type === "table") as { rows: Array<Record<string, unknown>> };
		expect(table.rows[0]).toMatchObject({ title: "Hello World", version: "v2" });

		// Delete.
		host.http.clear();
		await host.http.respond("https://deed.page/v1/sites/hello-world-ab12", json({ ok: true }));
		const deleted = await host.admin.actEditorPanel("deed-page", "posts", post.id, "unpublish", {
			user: admin,
		});
		expect(deleted.toast).toEqual({ type: "success", message: "Deleted from deed.page" });
		expect(host.http.requests()[0]?.method).toBe("DELETE");
		expect(await host.inspect.storage.list("sites")).toHaveLength(0);
	});

	it("shows deed.page error messages verbatim and stores nothing", async () => {
		const { host, admin, post } = await setup();
		await host.http.respond(
			PUBLISH_URL,
			json({ code: "slug_taken", message: "That slug belongs to another owner." }, 409),
		);
		const res = await host.admin.submitEditorPanel(
			"deed-page",
			"posts",
			post.id,
			"publish",
			{ slug: "taken-slug" },
			{ user: admin },
		);
		expect(res.toast).toEqual({ type: "error", message: "That slug belongs to another owner." });
		expect(await host.inspect.storage.list("sites")).toHaveLength(0);
	});

	it("rejects invalid names without calling deed.page", async () => {
		const { host, admin, post } = await setup();
		const res = await host.admin.submitEditorPanel(
			"deed-page",
			"posts",
			post.id,
			"publish",
			{ slug: "Not Valid!" },
			{ user: admin },
		);
		expect(res.toast?.type).toBe("error");
		expect(host.http.requests()).toHaveLength(0);
	});

	it("keeps the minted token when the site has no encryption key", async () => {
		const { host, admin, post } = await setup(false);
		await host.http.respond(
			PUBLISH_URL,
			json({ ok: true, url: "https://x-ab12.deed.page/", slug: "x-ab12", version: "v1", token: FAKE_TOKEN }, 201),
		);
		const res = await host.admin.submitEditorPanel("deed-page", "posts", post.id, "publish", { slug: "x-ab12" }, { user: admin });
		expect(res.toast?.type).toBe("success");
		expect(await host.inspect.kv.get("state:token")).toBe(FAKE_TOKEN);
		const page = await host.admin.loadPage("/sites", { user: admin });
		expect(page.blocks.some((b) => b.type === "banner")).toBe(true);
	});

	it("auto-updates a published entry on save", async () => {
		const { host, admin, post } = await setup();
		await host.http.respond(
			PUBLISH_URL,
			json({ ok: true, url: "https://auto-ab12.deed.page/", slug: "auto-ab12", version: "v1", token: FAKE_TOKEN }, 201),
		);
		await host.admin.submitEditorPanel("deed-page", "posts", post.id, "publish", { slug: "auto-ab12" }, { user: admin });
		host.http.clear();
		await host.http.respond(
			PUBLISH_URL,
			json({ ok: true, url: "https://auto-ab12.deed.page/", slug: "auto-ab12", version: "v2" }),
		);
		await host.transport.invokeHook("content:afterSave", {
			content: { ...post, data: { ...post.data, title: "Edited" } },
			collection: "posts",
			isNew: false,
		});
		const reqs = host.http.requests();
		expect(reqs).toHaveLength(1);
		expect(reqs[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
		const stored = await host.inspect.storage.list<{ version: string }>("sites");
		expect(stored[0]?.data.version).toBe("v2");
	});
});
