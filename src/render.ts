/**
 * Turns one EmDash content entry into a self-contained HTML page.
 *
 * Pure functions only: no EmDash runtime, no network. Portable Text blocks
 * (paragraphs, headings, quotes, lists, images, code) are rendered to HTML.
 * Everything is escaped; links are limited to http(s) and mailto.
 */

type Rec = Record<string, unknown>;

export interface RenderInput {
	/** Entry fields (`ContentItem.data`). */
	data: Rec;
	/** Entry slug, used as a fallback title. */
	slug?: string | null;
	/** Site name, shown in the footer. */
	siteName?: string;
	/** Absolute site URL, used to absolutize root-relative image URLs. */
	siteUrl?: string;
	/** Public URL of the original entry, used for rel=canonical. */
	canonicalUrl?: string | null;
	/** BCP 47 language tag. */
	lang?: string | null;
	publishedAt?: string | null;
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim() !== "" ? v : undefined;

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Returns a safe absolute URL or undefined. */
export function safeHref(value: unknown, base?: string): string | undefined {
	const raw = str(value);
	if (!raw) return undefined;
	try {
		const url = base ? new URL(raw, base) : new URL(raw);
		if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
			return url.href;
		}
	} catch {
		// relative URL without a base, or garbage
	}
	return undefined;
}

function isPortableText(value: unknown): value is Rec[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((b) => isRec(b) && typeof b._type === "string")
	);
}

function renderSpans(block: Rec, base?: string): string {
	const children = Array.isArray(block.children) ? block.children : [];
	const markDefs = new Map<string, Rec>();
	if (Array.isArray(block.markDefs)) {
		for (const def of block.markDefs) {
			if (isRec(def) && typeof def._key === "string") markDefs.set(def._key, def);
		}
	}
	let out = "";
	for (const child of children) {
		if (!isRec(child)) continue;
		let text = escapeHtml(typeof child.text === "string" ? child.text : "").replace(/\n/g, "<br>");
		const marks = Array.isArray(child.marks) ? child.marks : [];
		for (const mark of marks) {
			if (mark === "strong") text = `<strong>${text}</strong>`;
			else if (mark === "em") text = `<em>${text}</em>`;
			else if (mark === "code") text = `<code>${text}</code>`;
			else if (mark === "underline") text = `<u>${text}</u>`;
			else if (mark === "strike-through" || mark === "strikethrough") text = `<s>${text}</s>`;
			else if (typeof mark === "string" && markDefs.has(mark)) {
				const def = markDefs.get(mark)!;
				const href = safeHref(def.href, base);
				if (def._type === "link" && href) {
					text = `<a href="${escapeHtml(href)}" rel="noopener">${text}</a>`;
				}
			}
		}
		out += text;
	}
	return out;
}

function renderImage(block: Rec, base?: string): string {
	const asset = isRec(block.asset) ? block.asset : {};
	const src = safeHref(asset.url ?? block.url, base);
	const alt = str(block.alt) ?? "";
	const caption = str(block.caption);
	if (!src || src.startsWith("mailto:")) {
		return caption ? `<p class="caption">${escapeHtml(caption)}</p>` : "";
	}
	const img = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`;
	return `<figure>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
}

/** Renders a Portable Text array to HTML. Unknown block types are skipped. */
export function renderPortableText(blocks: unknown, base?: string): string {
	if (!Array.isArray(blocks)) return "";
	const out: string[] = [];
	let list: { tag: "ul" | "ol"; items: string[] } | null = null;
	const flush = () => {
		if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
		list = null;
	};
	for (const block of blocks) {
		if (!isRec(block)) continue;
		if (block._type === "block") {
			const inner = renderSpans(block, base);
			if (block.listItem === "bullet" || block.listItem === "number") {
				const tag = block.listItem === "number" ? "ol" : "ul";
				if (!list || list.tag !== tag) {
					flush();
					list = { tag, items: [] };
				}
				list.items.push(inner);
				continue;
			}
			flush();
			const style = typeof block.style === "string" ? block.style : "normal";
			if (/^h[1-6]$/.test(style)) {
				// h1 is reserved for the page title.
				const level = style === "h1" ? "h2" : style;
				out.push(`<${level}>${inner}</${level}>`);
			} else if (style === "blockquote") out.push(`<blockquote><p>${inner}</p></blockquote>`);
			else if (inner !== "") out.push(`<p>${inner}</p>`);
			continue;
		}
		flush();
		if (block._type === "image") out.push(renderImage(block, base));
		else if (block._type === "code" && typeof block.code === "string") {
			out.push(`<pre><code>${escapeHtml(block.code)}</code></pre>`);
		} else if (block._type === "break") out.push("<hr>");
	}
	flush();
	return out.join("\n");
}

/** Plain-text fallback for a string field: blank lines become paragraphs. */
function renderPlain(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

const BODY_KEYS = ["content", "body", "text"];

/** Builds the body HTML from the entry: Portable Text fields first, then plain body fields. */
export function renderBody(data: Rec, base?: string): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (isPortableText(value)) parts.push(renderPortableText(value, base));
		else if (BODY_KEYS.includes(key) && typeof value === "string") parts.push(renderPlain(value));
	}
	return parts.filter(Boolean).join("\n");
}

export function entryTitle(data: Rec, slug?: string | null): string {
	return str(data.title) ?? str(data.name) ?? str(slug ?? undefined) ?? "Untitled";
}

export function renderPage(input: RenderInput): string {
	const { data } = input;
	const title = entryTitle(data, input.slug);
	const summary = str(data.excerpt) ?? str(data.description) ?? str(data.summary);
	const base = safeHref(input.siteUrl);
	const canonical = safeHref(input.canonicalUrl);
	const lang = str(input.lang ?? undefined) ?? "en";
	const date = str(input.publishedAt ?? undefined);
	const dateLabel = date && !Number.isNaN(Date.parse(date)) ? date.slice(0, 10) : undefined;
	const body = renderBody(data, base);
	const site = str(input.siteName);

	const footer: string[] = [];
	if (canonical) {
		footer.push(
			`Originally published at <a href="${escapeHtml(canonical)}">${escapeHtml(site ?? canonical)}</a>.`,
		);
	} else if (site) {
		footer.push(`From ${escapeHtml(site)}.`);
	}

	return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${summary ? `<meta name="description" content="${escapeHtml(summary)}">\n` : ""}${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">\n` : ""}<meta name="generator" content="EmDash + deed.page">
<style>
:root{color-scheme:light dark;--fg:#1b1b1b;--muted:#666;--bg:#fff;--rule:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--muted:#aaa;--bg:#121212;--rule:#333}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:42rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:2.2rem;line-height:1.2;margin:0 0 .5rem}
.summary{font-size:1.15rem;color:var(--muted);margin:0 0 .5rem}
time{color:var(--muted);font-size:.9rem}
img{max-width:100%;height:auto}figure{margin:2rem 0}figcaption,.caption{color:var(--muted);font-size:.9rem}
blockquote{margin:1.5rem 0;padding-left:1rem;border-left:3px solid var(--rule);color:var(--muted)}
pre{overflow:auto;padding:1rem;border:1px solid var(--rule);border-radius:6px}
a{color:inherit}footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.9rem}
</style>
</head>
<body>
<main>
<article>
<header>
<h1>${escapeHtml(title)}</h1>
${summary ? `<p class="summary">${escapeHtml(summary)}</p>\n` : ""}${dateLabel ? `<time datetime="${escapeHtml(date!)}">${escapeHtml(dateLabel)}</time>\n` : ""}</header>
${body}
</article>
${footer.length ? `<footer>${footer.join(" ")}</footer>\n` : ""}</main>
</body>
</html>
`;
}
