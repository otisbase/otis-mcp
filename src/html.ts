import { iconVersion, wordmark } from "./brand";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]!);
}

/** Third-party text shown as a label (client names, invited business names): one line, control characters removed, capped. */
export function oneLine(value: string, max = 80): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Rate limits key IPv6 addresses by their /64, the block one connection usually holds. */
export function networkKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** Links to other sites open in a new tab, so the visitor keeps Otisbase open. Otisbase's own hosts and mailto links are left alone. */
export function externalLinks(html: string): string {
  return html.replace(/<a ((?:(?!target=)[^>])*?)href="(https?:\/\/(?![^"/]*otisbase\.com[/"])[^"]*)"((?:(?!target=)[^>])*)>/g,
    (_, before: string, href: string, after: string) => `<a ${before}href="${href}"${after} target="_blank" rel="noopener">`);
}

/** A two-tone heading for sign-in and error pages: what happened in ink, what to do in muted text. Both are HTML. */
export function heading(title: string, text: string): string {
  return `<h1 class="statement"><span class="st-title">${title}</span> <span class="st-text">${text}</span></h1>`;
}

/**
 * The shell for sign-in, consent and error pages on the MCP host: its own stylesheet (src/shell.ts), fonts and theme, a
 * wordmark-only header (no navigation to wander off mid-sign-in), and a narrow centred column.
 */
export function page(title: string, body: string, status = 200, headers?: HeadersInit, formRedirect?: URL): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  // no-referrer makes browser form POSTs send Origin: null, failing our CSRF check.
  responseHeaders.set("Referrer-Policy", "same-origin");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  // Chrome applies form-action to the OAuth redirect too. Only the already
  // validated client's callback origin (or native-app scheme) is added.
  const callback = formRedirect ? ` ${formRedirect.origin === "null" ? formRedirect.protocol : formRedirect.origin}` : "";
  responseHeaders.set("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self'${callback}; frame-ancestors 'none'; base-uri 'none'`);
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Otis</title>
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex">
  <link rel="icon" href="/favicon.svg?v=${iconVersion}" type="image/svg+xml">
  <link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
  <script src="/shell.js"></script>
  <link rel="stylesheet" href="/shell.css">
</head>
<body class="auth">
  <header class="auth-head"><a class="brand" href="/" aria-label="Otisbase home">${wordmark}</a></header>
  <main class="auth-main">${body}</main>
  <p id="copy-status" class="sr-only" role="status" aria-live="polite"></p>
  <footer class="auth-foot"><p>© 2026 Otisbase. All rights reserved.</p><p><a href="/terms" target="_blank" rel="noopener">Terms</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy</a></p></footer>
</body>
</html>`,
  { status, headers: responseHeaders });
}

// Phosphor Icons (regular weight, MIT), the two the copy button needs.
const copyIcon = `<svg class="icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"/></svg>`;
const checkIcon = `<svg class="icon icon-done" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>`;

/** A URL to copy, with a copy button the shell script reveals. */
export function copyBlock(id: string, text: string, label: string): string {
  return `<div class="copy-block copy-url"><pre><code id="${escapeHtml(id)}">${escapeHtml(text)}</code></pre><button class="copy" type="button" data-copy="${escapeHtml(id)}" aria-label="${escapeHtml(label)}" hidden>${copyIcon}${checkIcon}<span data-copy-label>Copy</span></button></div>`;
}
