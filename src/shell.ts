// The sign-in shell: the stylesheet and script for the sign-in, consent and error pages on mcp.otisbase.com
// (`page()` in html.ts). It carries only what those pages use, taken from the website's design: Geist, the
// light and dark tokens, the wordmark, pills, two-tone headings, the copy block and the auth layout.

export const shellStyles = String.raw`@font-face { font-family: "Geist"; src: url("/fonts/geist.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("/fonts/geist-mono.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
:root {
  color-scheme: light;
  --paper: #fafafa;
  --cta-line: #171717;
  --panel: #f2f2f2;
  --card: #f2f2f2;
  --win: #ffffff;
  --win-bar: #f4f4f4;
  --ink: #171717;
  --text: #333333;
  --muted: #707070;
  --line: #e6e6e6;
  --line-strong: #d6d6d6;
  --primary: #171717;
  --primary-hover: #333333;
  --on-primary: #fafafa;
  --soft: #e7e7e7;
  --link: #2a43ee;
  --wordmark-base: #656565;
  --blue: #2f4bff;
  --ok: #16834a;
  
  --tint: color-mix(in srgb, var(--blue) 4%, var(--win));
  --tint-line: color-mix(in srgb, var(--blue) 15%, var(--win));
  --tint-text: var(--otis);
  --syn-id: #8250df;
  --syn-money: #b35900;
  --syn-date: #116329;
  --syn-enum: #cf222e;
  --syn-text: #0550ae;
  --amber: #a35c00;
  --info: #fef6d2;
  --notice-bg: #0d0f17;
  --notice-line: #0d0f17;
  --info-text: #6e5a1c;
  --blue-soft: #94a6ff;
  --otis: #0d0f17;
  --otis-bar: #161926;
  --otis-line: #262a3b;
  --otis-text: #d8dbe8;
  --wash-base: #ffffff;
  --wash-mix: 20%;
  --mixp: 58%;
  --moon: block;
  --sun: none;
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --gutter: clamp(16px, 4.5vw, 70px);
  --ease: cubic-bezier(.16, 1, .3, 1);
  font: 16px/1.55 var(--sans);
  color: var(--text);
  background: var(--paper);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
@media (prefers-color-scheme: dark) {
:root:not([data-theme="light"]) { 
  color-scheme: dark;
  --paper: #121212;
  --cta-line: #2e2e2e;
  --ok: #3ddc84;
  --tint: color-mix(in srgb, var(--blue) 10%, var(--win));
  --tint-line: color-mix(in srgb, var(--blue) 22%, var(--win));
  --tint-text: #dde3ff;
  --syn-id: #d2a8ff;
  --syn-money: #ffa657;
  --syn-date: #7ee787;
  --syn-enum: #ff7b72;
  --syn-text: #79c0ff;
  --amber: #ffcf7a;
  --info: rgba(250, 204, 21, .14);
  --notice-bg: #0d0f17;
  --notice-line: #262a3b;
  --info-text: #e9d58f;
  --panel: #1a1a1a;
  --card: #1c1c1c;
  --win: #222222;
  --win-bar: #2a2a2a;
  --ink: #ededed;
  --text: #cfcfcf;
  --muted: #9a9a9a;
  --line: #2c2c2c;
  --line-strong: #3a3a3a;
  --primary: #ededed;
  --primary-hover: #ffffff;
  --on-primary: #121212;
  --soft: #2a2a2a;
  --link: #93a4ff;
  --wordmark-base: #a3a3a3;
  --wash-base: #1a1a1a;
  --wash-mix: 20%;
  --mixp: 100%;
  --moon: none;
  --sun: block;
 }
}
:root[data-theme="dark"] { 
  color-scheme: dark;
  --paper: #121212;
  --cta-line: #2e2e2e;
  --ok: #3ddc84;
  --tint: color-mix(in srgb, var(--blue) 10%, var(--win));
  --tint-line: color-mix(in srgb, var(--blue) 22%, var(--win));
  --tint-text: #dde3ff;
  --syn-id: #d2a8ff;
  --syn-money: #ffa657;
  --syn-date: #7ee787;
  --syn-enum: #ff7b72;
  --syn-text: #79c0ff;
  --amber: #ffcf7a;
  --info: rgba(250, 204, 21, .14);
  --notice-bg: #0d0f17;
  --notice-line: #262a3b;
  --info-text: #e9d58f;
  --panel: #1a1a1a;
  --card: #1c1c1c;
  --win: #222222;
  --win-bar: #2a2a2a;
  --ink: #ededed;
  --text: #cfcfcf;
  --muted: #9a9a9a;
  --line: #2c2c2c;
  --line-strong: #3a3a3a;
  --primary: #ededed;
  --primary-hover: #ffffff;
  --on-primary: #121212;
  --soft: #2a2a2a;
  --link: #93a4ff;
  --wordmark-base: #a3a3a3;
  --wash-base: #1a1a1a;
  --wash-mix: 20%;
  --mixp: 100%;
  --moon: none;
  --sun: block;
 }
* { box-sizing: border-box; }
html { scroll-padding-top: 112px; }
body { margin: 0; background: var(--paper); }
a { color: var(--ink); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--muted); }
h1 { margin: 0; color: var(--ink); font-weight: 400; text-wrap: balance; }
p { margin: 0 0 14px; text-wrap: pretty; }
code { font-family: var(--mono); font-size: .88em; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
p code { padding: 1px 5px; border-radius: 4px; background: var(--soft); color: var(--ink); overflow-wrap: anywhere; }
.icon { width: 16px; height: 16px; flex: none; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wordmark { display: block; width: auto; height: 18px; }
.wm-ink { fill: var(--ink); }
.wm-accent { fill: var(--wordmark-base); }
.pill { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 44px; padding: 0 22px; border: 1px solid var(--primary); border-radius: 8px; background: var(--primary); color: var(--on-primary); font: 400 16px/1 var(--sans); text-decoration: none; white-space: nowrap; transition: background-color .15s, border-color .15s; }
.pill:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: var(--on-primary); }
.pill:active { transform: scale(.98); }
.pill .icon { width: 15px; height: 15px; }
.pill-outline { background: transparent; border-color: var(--line-strong); color: var(--ink); }
.pill-outline:hover { background: var(--panel); border-color: var(--line-strong); color: var(--ink); }
.brand { display: inline-flex; align-items: center; gap: 9px; justify-self: start; color: var(--ink); font-size: 18px; font-weight: 600; letter-spacing: -.02em; text-decoration: none; }
.brand:hover { color: var(--ink); }
.statement { color: var(--ink); font-size: clamp(19px, 1.7vw, 23px); font-weight: 400; line-height: 1.32; letter-spacing: -.01em; }
.statement .st-text { color: var(--muted); }
.statement a { color: inherit; text-decoration: none; }
.statement a:hover .st-title { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 4px; }
.copy { display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 3px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: 400 12px/1.4 var(--sans); cursor: pointer; transition: opacity .2s, color .2s, background-color .2s; }
.copy:hover { color: var(--ink); background: var(--panel); }
.copy .icon { width: 12px; height: 12px; }
.copy .icon-done, .copy[data-copied] .icon:not(.icon-done) { display: none; }
.copy[data-copied] .icon-done { display: block; color: #1e9e5a; }
.copy-block { position: relative; margin-top: 10px; border: 1px solid var(--tint-line); border-radius: 8px; background: var(--tint); }
.copy-block pre { margin: 0; padding: 14px 92px 14px 16px; }
.copy-block code { padding: 0; background: none; color: var(--tint-text); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.copy-block .copy { position: absolute; top: 9px; right: 9px; margin: 0; height: 30px; padding: 0 10px; border: 1px solid var(--line-strong); background: var(--win); color: var(--ink); }
.auth { display: flex; flex-direction: column; min-height: 100dvh; }
.auth-head { width: min(560px, 100% - 2 * var(--gutter)); margin: 0 auto; padding-top: clamp(32px, 8vh, 72px); }
.auth-head .wordmark { height: 20px; }
.auth-main { flex: 1; width: min(560px, 100% - 2 * var(--gutter)); margin: 0 auto; padding-block: clamp(36px, 7vh, 64px) 40px; }
.auth-main h1.statement { max-width: none; margin: 0 0 28px; font-size: clamp(24px, 3vw, 28px); line-height: 1.25; letter-spacing: -.02em; text-wrap: wrap; }
.auth-main h1.statement strong { color: var(--ink); font-weight: 500; }
.auth-main h1 .st-text { display: block; margin-top: 4px; }
.auth-form { display: grid; gap: 8px; }
.auth-form label { color: var(--ink); font-size: 14px; font-weight: 500; }
.auth-form input:not([type="hidden"]) { box-sizing: border-box; width: 100%; height: 46px; padding: 0 14px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--win); color: var(--ink); font: 400 16px var(--sans); transition: border-color .15s, box-shadow .15s; }
.auth-form input:focus { border-color: var(--blue); outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 18%, transparent); }
.auth-form .auth-code { font-size: 22px; letter-spacing: .3em; font-variant-numeric: tabular-nums; }
.auth-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.auth-actions .pill { cursor: pointer; }
.auth-alert { margin: -8px 0 20px; padding: 12px 14px; border-radius: 8px; background: var(--info); color: var(--info-text); font-size: 14.5px; line-height: 1.5; }
.auth-small { margin: 28px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.6; overflow-wrap: anywhere; }
.auth-small strong { color: var(--text); font-weight: 500; }
.auth-small a, .auth-foot a { color: var(--link); }
.auth-foot p { margin: 0; }
.auth-foot p + p { margin-top: 4px; }
.auth-main .copy-block { margin: 0 0 20px; }
.auth-next { margin: 0; }
.auth-foot { width: min(560px, 100% - 2 * var(--gutter)); margin: 0 auto; padding: 20px 0 32px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
.copy-block pre { padding-right: 52px; }
.copy-url code { white-space: nowrap; overflow-wrap: normal; }
.copy-code pre { overflow-x: auto; scrollbar-width: thin; }
.copy-code code { white-space: pre; overflow-wrap: normal; }
.copy-block .copy { width: 34px; padding: 0; justify-content: center; }
.copy-block .copy [data-copy-label] { display: none; }
html { scroll-padding-top: 112px; }
}
@media print {
:root, :root[data-theme="dark"] { color-scheme: light; --paper: #fff; --panel: #fff; --ink: #111; --text: #222; --muted: #555; --line: #ddd; }
.copy { display: none !important; }
}
`;

/** Copy buttons on the shell pages (the /mcp browser page shows the server URL to copy). */
export const shellScript = String.raw`
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    if (navigator.clipboard && window.isSecureContext) {
      document.querySelectorAll('[data-copy]').forEach(function (button) {
        button.hidden = false;
        button.addEventListener('click', async function () {
          var target = document.getElementById(button.dataset.copy);
          var status = document.getElementById('copy-status');
          var label = button.querySelector('[data-copy-label]');
          if (!target || button.disabled) return;
          button.disabled = true;
          try {
            await navigator.clipboard.writeText(target.textContent.trim());
            button.dataset.copied = '';
            label.textContent = 'Copied';
            status.textContent = 'Copied to clipboard.';
          } catch (_) {
            label.textContent = 'Select the text to copy';
            status.textContent = 'Clipboard unavailable. Select and copy the text instead.';
          }
          window.setTimeout(function () {
            delete button.dataset.copied;
            label.textContent = 'Copy';
            button.disabled = false;
            status.textContent = '';
          }, 2200);
        });
      });
    }
  });
})();
`;
