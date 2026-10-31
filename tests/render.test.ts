import { describe, expect, it } from "vitest";

import { isValidSlug, slugify, suggestSlug } from "../src/deed.js";
import { renderPage, renderPortableText, safeHref } from "../src/render.js";

describe("renderPortableText", () => {
	it("renders blocks, marks, links and lists", () => {
		const html = renderPortableText([
			{ _type: "block", style: "h2", children: [{ _type: "span", text: "Intro" }] },
			{
				_type: "block",
				markDefs: [{ _key: "l1", _type: "link", href: "https://example.com" }],
				children: [
					{ _type: "span", text: "Hello ", marks: [] },
					{ _type: "span", text: "world", marks: ["strong", "l1"] },
				],
			},
			{ _type: "block", listItem: "bullet", children: [{ _type: "span", text: "a" }] },
			{ _type: "block", listItem: "bullet", children: [{ _type: "span", text: "b" }] },
			{ _type: "block", style: "blockquote", children: [{ _type: "span", text: "q" }] },
			{ _type: "code", code: "<x>" },
			{ _type: "image", asset: { _ref: "m1", url: "/_emdash/media/a.png" }, alt: "A" },
		], "https://site.example");
		expect(html).toContain("<h2>Intro</h2>");
		expect(html).toContain('<a href="https://example.com/" rel="noopener"><strong>world</strong></a>');
		expect(html).toContain("<ul><li>a</li><li>b</li></ul>");
		expect(html).toContain("<blockquote><p>q</p></blockquote>");
		expect(html).toContain("<pre><code>&lt;x&gt;</code></pre>");
		expect(html).toContain('src="https://site.example/_emdash/media/a.png"');
	});

	it("escapes text and drops unsafe links", () => {
		const html = renderPortableText([
			{
				_type: "block",
				markDefs: [{ _key: "x", _type: "link", href: "javascript:alert(1)" }],
				children: [{ _type: "span", text: "<script>", marks: ["x"] }],
			},
		]);
		expect(html).toBe("<p>&lt;script&gt;</p>");
		expect(safeHref("javascript:alert(1)")).toBeUndefined();
	});
});

describe("renderPage", () => {
	it("builds a full document with canonical link", () => {
		const html = renderPage({
			data: { title: "A & B", excerpt: "Short", content: [] },
			siteName: "My site",
			canonicalUrl: "https://site.example/posts/a",
		});
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain("<title>A &amp; B</title>");
		expect(html).toContain('<link rel="canonical" href="https://site.example/posts/a">');
		expect(html).toContain('<p class="summary">Short</p>');
	});
});

describe("slugs", () => {
	it("validates and suggests deed.page slugs", () => {
		expect(isValidSlug("my-post-1a2b")).toBe(true);
		expect(isValidSlug("-bad")).toBe(false);
		expect(isValidSlug("v2--x")).toBe(false);
		expect(slugify("Héllo, Wörld!")).toBe("hello-world");
		const s = suggestSlug("Hello World");
		expect(s).toMatch(/^hello-world-[a-z0-9]{4}$/);
		expect(isValidSlug(s)).toBe(true);
	});
});
