import {
  OAuthAuthorizationServer, OAuthResourceServer, AuthorizationError,
  authorizationErrorRedirect
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import { escapeHtml, heading, networkKey, oneLine, page } from "./html";
import { eu } from "./regions";
import { notifyConnection } from "./notify";

/** Wrong sign-in codes allowed per email in 24 hours, across all flows. */
export const FAILED_CODES_PER_DAY = 10;
/** Sign-in code emails Otis sends per hour in total. */
export const SIGN_IN_EMAILS_PER_HOUR = 300;
/** Code requests per email address and per network (Stefan, 2026-10-24). */
export const CODES_PER_EMAIL_HOUR = 50, CODES_PER_EMAIL_DAY = 200, CODES_PER_NETWORK_HOUR = 50;

function tooManyWrongCodes(): Response {
  return page("Try later", heading("Too many wrong codes.", "Try again tomorrow."), 429, { "Retry-After": "86400" });
}

// email is the verified sign-in address, carried only by connections made after feedback_send was added.
export type Identity = { userId: string; email?: string };
export const ACCESS_SCOPE = "otis:records";
const COOKIE = "__Host-otis-connect";

export async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function authorizationServer(env: Env) {
  return new OAuthAuthorizationServer<Env>({
    issuer: env.ORIGIN,
    resources: [`${env.ORIGIN}/mcp`],
    scopesSupported: [ACCESS_SCOPE, "offline_access"],
    clientRegistrationEndpoint: `${env.ORIGIN}/oauth/register`,
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 60 * 60 * 24 * 30
  });
}

export function resourceServer(env: Env, handler: (
  request: Request, env: Env, context: ExecutionContext, identity: Identity
) => Promise<Response>) {
  const authorization = authorizationServer(env);
  return new OAuthResourceServer<Env, Identity>({
    resourceMetadata: {
      resource: `${env.ORIGIN}/mcp`,
      authorization_servers: [env.ORIGIN],
      resource_name: "Otis business records"
    },
    requiredScopes: [ACCESS_SCOPE],
    validateToken: (bindings) => (resource, token) => authorization.validateToken(resource, token, bindings),
    handler: {
      fetch(request, bindings, context) {
        if (!context.auth.scope.includes(ACCESS_SCOPE) ||
          !context.props?.userId || context.props.userId !== context.auth.userId) {
          return new Response("Access denied.", { status: 403 });
        }
        return handler(request, bindings, context, context.props);
      }
    }
  });
}

function formFields(id: string, csrf: string): string {
  return `<input type="hidden" name="flow" value="${escapeHtml(id)}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function expired(): Response {
  return page("Connection expired", heading("This sign-in has expired.", "Go back to your assistant and connect again."), 400);
}

/** The two steps share one layout: a heading, an optional alert, one field, two buttons, and optional small print. */
function step(title: string, text: string, error: string, form: string, small = ""): string {
  return `${heading(title, text)}${error ? `<p class="auth-alert" role="alert">${escapeHtml(error)}</p>` : ""}${form}${small ? `<p class="auth-small">${small}</p>` : ""}`;
}

/** The site or app that receives access, as the consent page names it. */
function returnHost(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.host || url.protocol.replace(/:$/, "");
}

function connectForm(id: string, csrf: string, clientName: string, clientId: string, redirectUri: string, error = ""): string {
  return step("Connect your assistant to Otis.", `<strong>${escapeHtml(clientName)}</strong> at <strong>${escapeHtml(returnHost(redirectUri))}</strong> wants to read and change your business records.`, error,
    `<form class="auth-form" method="post" action="/authorize/start">${formFields(id, csrf)}
<label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required autofocus>
<div class="auth-actions"><button class="pill" type="submit">Send a code</button><button class="pill pill-outline" type="submit" name="deny" value="yes" formnovalidate>Cancel</button></div></form>`,
    `Returns to ${escapeHtml(redirectUri)} · client ${escapeHtml(clientId)}`);
}

function verifyForm(id: string, csrf: string, email: string, clientName: string, error = ""): string {
  return step("Check your email.", `Enter the six-digit code we sent to <strong>${escapeHtml(email)}</strong>.`, error,
    `<form class="auth-form" method="post" action="/authorize/verify">${formFields(id, csrf)}
<label for="code">Code</label><input id="code" class="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus>
<div class="auth-actions"><button class="pill" type="submit">Verify and connect</button><button class="pill pill-outline" type="submit" name="deny" value="yes" formnovalidate>Cancel</button></div></form>`,
    `By continuing, you accept the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.`);
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.SIGN_IN_ENABLED !== "true") {
    return page("Sign-in unavailable", heading("Sign-in is turned off here.", "Use the live service at otisbase.com."), 503);
  }
  const oauth = authorizationServer(env).getOAuthApi(env);
  if (request.method === "GET" && url.pathname === "/authorize") {
    try {
      const authRequest = await oauth.parseAuthRequest(request);
      if (authRequest.scope.some((scope) => ![ACCESS_SCOPE, "offline_access"].includes(scope))) {
        return page("Unsupported access", heading("Otis can’t grant that access.", "Go back to your assistant and connect again."), 400);
      }
      const client = await oauth.lookupClient(authRequest.clientId);
      if (!client) return expired();
      const id = crypto.randomUUID();
      const cookie = crypto.randomUUID() + crypto.randomUUID();
      const csrf = crypto.randomUUID();
      // Dynamically registered names are unverified: keep them to one short line, and show where access goes.
      const clientName = oneLine(client.clientName ?? authRequest.clientId) || "An assistant";
      await eu(env.SIGN_INS).getByName(`flow:${id}`).create({
        request: authRequest, clientName, cookieHash: await digest(cookie), csrf, expires: Date.now() + 600_000
      });
      return page("Connect", connectForm(id, csrf, clientName, authRequest.clientId, authRequest.redirectUri),
      200, { "Set-Cookie": `${COOKIE}=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` }, new URL(authRequest.redirectUri));
    } catch (error) {
      if (error instanceof AuthorizationError) return page("Connection error", heading("We couldn’t start the connection.", `${escapeHtml(error.description.replace(/[.!?]?$/, "."))} Go back to your assistant and try again.`), 400);
      return page("Connection error", heading("We couldn’t start the connection.", "Go back to your assistant and try again."), 400);
    }
  }
  if (request.method !== "POST" || request.headers.get("Origin") !== env.ORIGIN) {
    return new Response("Invalid request.", { status: 403 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        return new Response("Request too large.", { status: 413 });
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  const body = new TextDecoder().decode(bytes);
  const form = new URLSearchParams(body);
  const id = form.get("flow") ?? "";
  const csrf = form.get("csrf") ?? "";
  const cookie = request.headers.get("Cookie")?.split(";").map((v) => v.trim())
    .find((value) => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!/^[a-f0-9-]{36}$/.test(id) || !cookie) return expired();
  const store = eu(env.SIGN_INS).getByName(`flow:${id}`);
  const cookieHash = await digest(cookie);
  const flow = await store.read(cookieHash, csrf);
  if (!flow) return expired();
  if (form.get("deny") === "yes") {
    await store.cancel(cookieHash, csrf);
    return new Response(null, { status: 303, headers: {
      Location: authorizationErrorRedirect(flow.request, "access_denied"),
      "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
    } });
  }
  if (url.pathname === "/authorize/start") {
    const parsedEmail = z.string().email().max(254).safeParse(form.get("email")?.trim().toLowerCase());
    if (!parsedEmail.success) return page("Connect", connectForm(id, csrf, flow.clientName, flow.request.clientId, flow.request.redirectUri, "Check the email address and try again."), 400, undefined, new URL(flow.request.redirectUri));
    const email = parsedEmail.data;
    const emailId = await digest(email);
    const ipId = await digest(networkKey(request.headers.get("CF-Connecting-IP") ?? "local"));
    if (await eu(env.SIGN_INS).getByName(`failed:${emailId}`).blocked(FAILED_CODES_PER_DAY)) return tooManyWrongCodes();
    // Directory reviewers cannot read an inbox: the one REVIEW_EMAIL address takes the fixed REVIEW_CODE secret
    // instead of an emailed code. It sends no email, so the sending limits below do not apply, and several reviewers
    // share it; the guess limits do. Both are secrets; deleting either switches it off.
    if (env.REVIEW_EMAIL && env.REVIEW_CODE && email === env.REVIEW_EMAIL.toLowerCase()) {
      if (!await store.setCode(cookieHash, csrf, email, await digest(`${id}:${env.REVIEW_CODE}`))) return expired();
      return page("Verify email", verifyForm(id, csrf, email, flow.clientName), 200, undefined, new URL(flow.request.redirectUri));
    }
    const allowed = await eu(env.SIGN_INS).getByName(`email:${emailId}`).allow(CODES_PER_EMAIL_HOUR, 3_600_000)
      && await eu(env.SIGN_INS).getByName(`email-day:${emailId}`).allow(CODES_PER_EMAIL_DAY, 86_400_000);
    const ipAllowed = await eu(env.SIGN_INS).getByName(`ip:${ipId}`).allow(CODES_PER_NETWORK_HOUR, 3_600_000);
    if (!allowed || !ipAllowed) return page("Try later", heading("Too many attempts.", "Wait an hour, then try again."), 429, { "Retry-After": "3600" });
    // One cap on all code emails, so no spread of addresses can turn sign-in into a mailer.
    if (!await eu(env.SIGN_INS).getByName("send:all").allow(SIGN_IN_EMAILS_PER_HOUR, 3_600_000)) {
      return page("Email unavailable", heading("We couldn’t send your code.", "Try again in a few minutes."), 503, { "Retry-After": "600" });
    }
    const random = new Uint32Array(1);
    // Rejection sampling avoids modulo bias in the six-digit code.
    do { crypto.getRandomValues(random); } while (random[0] >= 4_294_000_000);
    const code = String(random[0] % 1_000_000).padStart(6, "0");
    if (!await store.setCode(cookieHash, csrf, email, await digest(`${id}:${code}`))) return expired();
    try {
      await env.EMAIL.send({
        to: email, from: env.EMAIL_FROM, subject: "Your Otis sign-in code",
        text: `Your Otis code is ${code}. It expires in 10 minutes. Enter it only on the Otis connection page. If you did not request this, ignore this message.`,
        html: `<p>Your Otis sign-in code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. Enter it only on the Otis connection page. If you did not request this, ignore this message.</p>`
      });
    } catch {
      return page("Email unavailable", heading("We couldn’t send your code.", "Try again in a few minutes."), 503);
    }
    return page("Verify email", verifyForm(id, csrf, email, flow.clientName), 200, undefined, new URL(flow.request.redirectUri));
  }
  if (url.pathname === "/authorize/verify") {
    const code = form.get("code") ?? "";
    // Wrong codes count per email across every flow, so starting again does not reset the guesses.
    const failed = flow.email ? eu(env.SIGN_INS).getByName(`failed:${await digest(flow.email)}`) : null;
    if (failed && await failed.blocked(FAILED_CODES_PER_DAY)) return tooManyWrongCodes();
    const verified = await store.verify(cookieHash, csrf, await digest(`${id}:${code}`));
    if (!verified?.email) {
      if (failed) await failed.allow(FAILED_CODES_PER_DAY, 86_400_000);
      return page("Verify email", verifyForm(id, csrf, flow.email ?? "", flow.clientName, "That code is wrong or has expired."), 400, undefined, new URL(flow.request.redirectUri));
    }
    const userId = await digest(`otis-user:${verified.email}`);
    let redirectTo: string;
    try {
      ({ redirectTo } = await oauth.completeAuthorization({
        request: verified.request, userId, metadata: {},
        scope: Array.from(new Set([...verified.request.scope, ACCESS_SCOPE])),
        props: { userId, email: verified.email } satisfies Identity
      }));
    } catch {
      return page("Connection error", heading("We couldn’t finish the connection.", "Go back to your assistant and connect again."), 502);
    }
    await notifyConnection(env, verified.email, flow.clientName);
    return new Response(null, { status: 303, headers: {
      Location: redirectTo, "Cache-Control": "no-store",
      "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
    } });
  }
  return new Response("Not found.", { status: 404 });
}
