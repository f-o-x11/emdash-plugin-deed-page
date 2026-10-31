/**
 * Minimal deed.page API client (https://deed.page/docs).
 *
 * - POST /v1/sites            publish or update a site (JSON body with files)
 * - DELETE /v1/sites/{slug}   delete a site
 *
 * The first publish without a token mints one and returns it once. Callers
 * must store it; it is the only way to update or delete the site later.
 */

export const DEED_API = "https://deed.page";
export const CLIENT_NAME = "EmDash deed.page plugin";
/** Request bodies above 4 MB are rejected by deed.page. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface PublishResult {
	ok: true;
	url: string;
	slug: string;
	version: string;
	/** Only present when this request minted a new owner token. */
	token?: string;
}

export interface DeedError {
	ok: false;
	status: number;
	code: string;
	/** Human-readable message from deed.page (may contain an upgrade link). */
	message: string;
	/** A first publish over the size limit still mints an owner token. */
	token?: string;
}

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug) && !/^v\d+--/.test(slug);
}

/** Lowercase, hyphenate, trim to 63 chars. Returns "" when nothing usable is left. */
export function slugify(input: string, maxLength = 63): string {
	return input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
}

/** Suggests a free-looking slug: `<entry-slug>-<4 random chars>`. */
export function suggestSlug(base: string): string {
	const bytes = new Uint8Array(3);
	crypto.getRandomValues(bytes);
	const suffix = Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
		.join("")
		.slice(0, 4);
	const stem = slugify(base, 58) || "page";
	return `${stem}-${suffix}`;
}

async function readError(res: Response): Promise<DeedError> {
	let code = `http_${res.status}`;
	let message = `deed.page returned HTTP ${res.status}`;
	try {
		const body = (await res.json()) as Record<string, unknown>;
		if (typeof body.error === "string") code = body.error;
		else if (typeof body.code === "string") code = body.code;
		const text = body.message_for_user ?? body.message ?? body.user_message;
		if (typeof text === "string" && text) message = text;
		if (typeof body.token === "string" && body.token) {
			return { ok: false, status: res.status, code, message, token: body.token };
		}
	} catch {
		// non-JSON body (e.g. platform 413)
	}
	return { ok: false, status: res.status, code, message };
}

export async function publishSite(
	fetchFn: FetchFn,
	opts: { slug: string; html: string; token?: string | null; ref?: string },
): Promise<PublishResult | DeedError> {
	if (!isValidSlug(opts.slug)) {
		return {
			ok: false,
			status: 400,
			code: "bad_slug",
			message:
				"Slug must be 1-63 lowercase letters, digits, or hyphens, with no leading or trailing hyphen.",
		};
	}
	const body = JSON.stringify({ slug: opts.slug, files: { "index.html": opts.html } });
	if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
		return { ok: false, status: 413, code: "too_large", message: "Page is larger than 4 MB." };
	}
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-client": CLIENT_NAME,
	};
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	const ref = encodeURIComponent(opts.ref ?? "emdash-plugin");
	const res = await fetchFn(`${DEED_API}/v1/sites?ref=${ref}`, { method: "POST", headers, body });
	if (!res.ok) return readError(res);
	const json = (await res.json()) as Record<string, unknown>;
	if (typeof json.url !== "string" || typeof json.slug !== "string") {
		return { ok: false, status: res.status, code: "bad_response", message: "Unexpected response from deed.page." };
	}
	return {
		ok: true,
		url: json.url,
		slug: json.slug,
		version: typeof json.version === "string" ? json.version : "",
		...(typeof json.token === "string" && json.token ? { token: json.token } : {}),
	};
}

export async function deleteSite(
	fetchFn: FetchFn,
	opts: { slug: string; token: string },
): Promise<{ ok: true } | DeedError> {
	if (!isValidSlug(opts.slug)) {
		return { ok: false, status: 400, code: "bad_slug", message: "Invalid slug." };
	}
	const res = await fetchFn(`${DEED_API}/v1/sites/${opts.slug}`, {
		method: "DELETE",
		headers: { authorization: `Bearer ${opts.token}`, "x-client": CLIENT_NAME },
	});
	// 404 means it is already gone; treat as success so local state can be cleared.
	if (res.ok || res.status === 404) return { ok: true };
	return readError(res);
}
