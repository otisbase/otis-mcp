import { authorizationServer, authorize, resourceServer } from "./auth";
import { handleMcp } from "./mcp";
import { docsResponse } from "./docs";
import { copyBlock, escapeHtml, heading, networkKey, page } from "./html";
import { favicon } from "./brand";
import { shellScript, shellStyles } from "./shell";
import geist from "./fonts/geist.woff2";
import geistMono from "./fonts/geist-mono.woff2";
export { AccountStore } from "./account-store";
export { BusinessStore } from "./business-store";
export { FeedbackStore } from "./feedback";
export { RegistryStore } from "./registry";
export { SignInStore } from "./sign-in-store";


/** Pages of the website at SITE_ORIGIN. Opened on the MCP host, they redirect there. */
const sitePages = new Set(["/", "/how-it-works", "/connect", "/skills", "/pricing", "/docs", "/about", "/privacy", "/terms", "/dpa", "/sitemap.xml", "/robots.txt"]);

/** The sign-in shell's own assets (src/shell.ts, src/fonts), so sign-in pages never depend on the website. */
function shellAsset(pathname: string): Response | null {
  const body = pathname === "/shell.css" ? shellStyles : pathname === "/shell.js" ? shellScript : pathname === "/favicon.svg" ? favicon
    : pathname === "/fonts/geist.woff2" ? geist : pathname === "/fonts/geist-mono.woff2" ? geistMono : null;
  if (body === null) return null;
  const type = pathname.endsWith(".css") ? "text/css; charset=utf-8" : pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : pathname.endsWith(".svg") ? "image/svg+xml" : "font/woff2";
  return new Response(body, { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff",
    "Cache-Control": pathname.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "no-cache" } });
}

/** Every HTTPS response tells browsers to keep using HTTPS for a year. */
function secure(response: Response, https: boolean): Response {
  if (!https || response.status === 101) return response;
  const copy = new Response(response.body, response);
  copy.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return copy;
}

/** Permanent redirects for search engines and people: HTTP to HTTPS, trailing slashes, and website pages to the website. */
function canonicalRedirect(request: Request, env: Env, url: URL): Response | null {
  // Cloudflare reports the visitor's scheme in CF-Visitor. Local dev and tests do not send it, so they are never redirected.
  const page = request.method === "GET" || request.method === "HEAD";
  if ((request.headers.get("CF-Visitor") ?? "").includes('"http"')) return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
  if (!page) return null;
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`, 301);
  const site = new URL(env.SITE_ORIGIN);
  if (url.host !== site.host && sitePages.has(url.pathname)) return Response.redirect(`${site.origin}${url.pathname}${url.search}`, 301);
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const https = (request.headers.get("CF-Visitor") ?? "").includes('"https"') || (url.protocol === "https:" && !request.headers.has("CF-Visitor"));
    return secure(await route(request, env, ctx, url), https);
  }
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
    if (url.hostname !== new URL(env.ORIGIN).hostname) return new Response("Unknown host.", { status: 421 });
    const redirect = canonicalRedirect(request, env, url);
    if (redirect) return redirect;
    if (url.pathname === "/demo/mcp" || url.pathname === "/oauth/register" || url.pathname.startsWith("/authorize")) {
      const key = `${url.pathname}:${networkKey(request.headers.get("CF-Connecting-IP") ?? "local")}`;
      if (!(await env.PUBLIC_REQUESTS.limit({ key })).success) return new Response("Too many requests. Try again shortly.", { status: 429, headers: { "Retry-After": "60" } });
    }
    if (url.pathname === "/health") return Response.json({ status: "ok", version: "0.1.0", sign_in_enabled: env.SIGN_IN_ENABLED === "true" });
    // OpenAI's plugin portal proves we own the MCP host by fetching its token here, as plain text and nothing else.
    if (url.pathname === "/.well-known/openai-apps-challenge" && env.OPENAI_APPS_CHALLENGE) {
      return new Response(env.OPENAI_APPS_CHALLENGE, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const docs = docsResponse(url.pathname, env);
    if (docs) return docs;
    const asset = request.method === "GET" || request.method === "HEAD" ? shellAsset(url.pathname) : null;
    if (asset) return asset;
    if (url.pathname === "/demo/mcp") return handleMcp(request, env, ctx);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      const response = await resourceServer(env, handleMcp).fetch(request, env, ctx);
      // Someone who opens the server URL in a browser gets a short explanation instead of an empty 401.
      // MCP clients do not ask for HTML, and keep the same status and WWW-Authenticate challenge.
      if (url.pathname === "/mcp" && response.status === 401 && request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html")) {
        const challenge = response.headers.get("WWW-Authenticate");
        return page("Otis MCP server", `${heading("This is the Otis MCP server.", "Add this address to your AI assistant rather than opening it in a browser.")}${copyBlock("mcp-url", `${env.ORIGIN}/mcp`, "Copy server URL")}<p class="auth-next"><a class="pill" href="${escapeHtml(env.SITE_ORIGIN)}/connect">Setup steps for your assistant</a></p>`, 401, challenge ? { "WWW-Authenticate": challenge } : undefined);
      }
      return response;
    }
    if (url.pathname.startsWith("/authorize")) return authorize(request, env, ctx);
    const response = await authorizationServer(env).fetch(request, env, ctx);
    // An unknown address on the MCP host, opened in a browser, gets the sign-in shell rather than plain text.
    if (response.status === 404 && request.method === "GET" && (request.headers.get("Accept") ?? "").includes("text/html")) {
      return page("Not found", `${heading("There’s nothing at this address.", "This is the Otis MCP server. Add its address to your AI assistant, or read the setup steps.")}<p class="auth-next"><a class="pill" href="${escapeHtml(env.SITE_ORIGIN)}/connect">Setup steps for your assistant</a></p>`, 404);
    }
    return response;
}
