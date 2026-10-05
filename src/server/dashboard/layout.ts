/**
 * The Dashboard shell: one dark, mobile-first frame shared by every page — nav (Live · Ledger · Pool · Giveaways · Config · Debug · Help;
 * the Config and Debug tabs only for the Streamer — the routes are gated server-side regardless), role badge, inline CSS with 44 px
 * tap targets, and the `client.js` include — plus the `h` template tag the pages build their HTML with. `h` escapes every interpolated value; only a `Raw` (from `raw()` or another `h` call) passes
 * through untouched, so a user string can never reach the page unescaped by accident.
 */
import type { AppListener, Principal } from "../auth.ts";
import { escapeHtml } from "../http-util.ts";

const LOGOUT_HREF = "/logout"; // app.ts's LOGOUT_PATH — a literal here keeps app → pages → layout free of an import cycle

export class Raw {
  constructor(readonly html: string) {}
}

export const raw = (html: string): Raw => new Raw(html);

/** What `h` accepts between the literal parts: text (escaped), numbers, nothing, `Raw` (verbatim), or lists of those. */
export type Value = string | number | boolean | null | undefined | Raw | Value[];

function render(v: Value): string {
  if (v instanceof Raw) return v.html;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || typeof v === "boolean") return ""; // `${cond && h`...`}` idiom
  return escapeHtml(String(v));
}

export function h(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return new Raw(out);
}

/** `setup` is the Setup page's key: never a tab, reached from Config and the first-run redirect. */
export type NavKey = "live" | "ledger" | "pool" | "giveaways" | "config" | "debug" | "help" | "setup";

const NAV: ReadonlyArray<readonly [NavKey, string, string]> = [
  ["live", "/", "Live"],
  ["ledger", "/ledger", "Ledger"],
  ["pool", "/pool", "Pool"],
  ["giveaways", "/giveaways", "Giveaways"],
  ["config", "/config", "Config"],
  ["debug", "/debug", "Debug"],
  ["help", "/help", "Help"],
];

export const CLIENT_JS_PATH = "/dashboard/client.js";

const CSS = `
:root{color-scheme:dark;--ink:#0b0b14;--panel:#141428;--line:#2b2b5a;--quiet:#1c1c38;--text:#e8e8f0;--text2:#c8c8e0;--muted:#8a8aa8;--accent:#26f0ff;--fire:#ff3df0;--gold:#ffd166;--live:#3ddc97;--danger:#ff6b6b;--r:12px;--r2:8px}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--ink);color:var(--text);font:17px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);padding:.3rem .4rem;display:flex;align-items:center;justify-content:space-between;gap:.4rem}
nav{display:flex;gap:.1rem;overflow-x:auto;flex:1 1 auto}
nav a{display:inline-block;min-height:44px;line-height:44px;padding:0 .45rem;border-radius:var(--r2);color:var(--text2);text-decoration:none;font-weight:600;font-size:.95rem;white-space:nowrap}
nav a.active{background:var(--accent);color:var(--ink)}
.badge{font-size:.85rem;color:var(--gold);white-space:nowrap;text-align:right}
.badge a{display:block;color:var(--text2)}
main{max-width:720px;margin:0 auto;padding:.75rem}
main.xwide{max-width:none;padding:1rem 2rem}
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:.75rem;margin:0 0 12px}
h1{font-size:1.25rem;margin:0 0 .5rem}
h2{font-size:13px;font-weight:700;margin:0 0 .5rem;color:var(--text2);text-transform:uppercase;letter-spacing:.06em}
h3{font-size:1.05rem;margin:1rem 0 .25rem;color:var(--gold)}
.help h3{margin-top:1.25rem}
.help h3:first-child{margin-top:0}
p{margin:.4rem 0}
ul{margin:.4rem 0;padding-left:1.25rem}
button,.btn,input,select,textarea{font:inherit;min-height:44px;border-radius:var(--r2);border:1px solid var(--line);background:var(--quiet);color:var(--text);padding:0 .75rem}
button,.btn{cursor:pointer;font-weight:600;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:.3rem}
button.primary,.btn.primary{background:var(--accent);color:var(--ink);border-color:var(--accent)}
button.danger{background:#4a1520;border-color:var(--danger)}
button.ghost{background:transparent}
button.sm{min-height:34px;padding:0 .55rem;font-size:.85rem}
button:disabled{opacity:.5;cursor:default}
input[type=checkbox]{min-height:0;width:1.6rem;height:1.6rem;margin:0 .5rem 0 0;vertical-align:middle}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
kbd{font:inherit;font-size:.75rem;font-weight:700;background:#26263f;border:1px solid #4a4a7a;border-bottom-width:2px;border-radius:5px;padding:0 .35rem;color:var(--text);white-space:nowrap}
#fire{width:100%;min-height:76px;margin-top:.75rem;font-size:1.7rem;letter-spacing:.12em;background:var(--fire);border-color:var(--fire);color:var(--ink)}
#fire.armed{background:var(--gold);border-color:var(--gold)}
.fader{font-size:34px;font-weight:800;font-variant-numeric:tabular-nums}
.meta{display:flex;flex-wrap:wrap;gap:.25rem 1rem;color:var(--text2);font-weight:600}

/* ---------- Live: one number, a bar, two quiet cards, what came up, five plain lines ---------- */
.big-number{font-size:56px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05;letter-spacing:-.01em;margin-top:.1rem}
.big-number small{font-size:22px;font-weight:700;color:var(--text2);letter-spacing:0}
.bar{height:8px;border-radius:999px;background:var(--quiet);overflow:hidden;margin:.7rem 0 1rem}
.bar i{display:block;height:100%;background:var(--accent);border-radius:999px;min-width:0}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.card{background:var(--quiet);border-radius:var(--r2);padding:.6rem .75rem;min-width:0}
.card h2{margin:0;color:var(--muted)}
.card .n{font-size:34px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.15}
.card .sub{margin:0;color:var(--text2);font-size:.9rem}
.came-up .what{display:flex;align-items:center;gap:.6rem;font-size:22px;font-weight:800;line-height:1.2}
.came-up .glyph{font-size:1.7rem;line-height:1}
.came-up .muted{margin:.15rem 0 0}
.came-up .actions{margin-top:.6rem}
.latest{list-style:none;margin:0;padding:0}
.latest li{display:flex;gap:.6rem;align-items:baseline;padding:.45rem 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
.latest li:first-child{border-top:0;padding-top:.1rem}
.latest time{flex:none;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
.latest li.muted span{text-decoration:line-through;text-decoration-color:#8a8aa888}
details.byhand>summary{list-style:none;cursor:pointer;min-height:44px;display:flex;align-items:center;gap:.5rem;font-weight:600;color:var(--text2)}
details.byhand>summary::-webkit-details-marker{display:none}
details.byhand>summary::before{content:"+";display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;border-radius:50%;border:1px solid var(--line);color:var(--muted);font-weight:700;flex:none}
details.byhand[open]>summary::before{content:"–"}
details.byhand[open]>summary{margin-bottom:.25rem}
.banner{display:flex;justify-content:space-between;align-items:center;gap:.5rem;border-radius:var(--r2);padding:.5rem .75rem;margin:0 0 .5rem}
.banner.warn{background:#4a3210;border:1px solid var(--gold)}
.banner.info{background:#16254a;border:1px solid var(--accent)}
.row{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:.5rem 0}
.row>input:not([type=checkbox]),.row>select{flex:1 1 8rem;min-width:0}
label.field{display:block;margin:.5rem 0}
label.field>span{display:flex;align-items:center;gap:.35rem;font-size:.85rem;color:var(--text2);margin-bottom:.2rem}
label.field input,label.field select{width:100%}
label.field input[type=range]{accent-color:var(--accent);margin:.2rem 0}
label.field output{color:var(--gold);font-weight:700}
label.check{display:flex;align-items:center;min-height:44px;gap:.2rem}
label.check .tip{margin-left:.2rem}
textarea{width:100%;min-height:18rem;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.8rem;padding:.5rem;line-height:1.35}
textarea.lines{min-height:8rem;font-family:inherit;font-size:.95rem;white-space:pre;overflow-x:auto;text-transform:uppercase}
/* Pool page draw-list editors: a row is a radio (the selection, never a tab stop) and one input; − asks in the row */
.lrows{list-style:none;margin:0 0 .3rem;padding:0}
.lrow{display:flex;align-items:center;gap:.45rem;padding:.12rem 0;min-height:40px}
.lrow input[type=radio]{min-height:0;width:1.15rem;height:1.15rem;margin:0;flex:none;accent-color:var(--accent);cursor:pointer}
.lrow .item{flex:1 1 auto;min-width:0;min-height:36px;padding:0 .5rem;font-size:.95rem}
.lrow.selected .item{border-color:var(--accent)}
.lrow.confirming .item,.lrow.confirming input[type=radio]{display:none}
.lrow .confirm{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem;flex:1 1 auto;color:var(--text2)}
.lrow .confirm b{color:var(--text);overflow-wrap:anywhere}
.list-editor .actions{align-items:center}
.list-editor .actions button[data-list-act]{min-width:2.6rem;font-size:1.15rem;line-height:1}
.list-editor .actions button[type=submit]{margin-left:auto}
.lstatus{margin:.3rem 0 0;min-height:1.2em}
details.more{margin:.2rem 0 0}
details.more>summary{cursor:pointer;color:var(--accent);font-size:.85rem;min-height:0}
details.more ul{margin:.3rem 0 0;padding-left:1rem;font-size:.85rem;font-family:ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
details.more li{padding:.1rem 0}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:.4rem .3rem;border-top:1px solid var(--line);vertical-align:top}
th{color:var(--text2);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
td.n{white-space:nowrap}
.actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem}
.actions form{display:flex;gap:.4rem}
.status-live{color:var(--live)}.status-suspended{color:var(--gold)}.status-retired{color:var(--danger)}
.muted{color:var(--muted)}
.small{font-size:.85rem}
.err{color:var(--danger);white-space:pre-wrap;margin:.5rem 0 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem}
.ok{color:var(--live)}
code{background:var(--quiet);padding:.05rem .3rem;border-radius:4px;font-size:.9em}
#toast{position:fixed;left:50%;bottom:1rem;transform:translateX(-50%);background:#4a1520;border:1px solid var(--danger);padding:.75rem 1rem;border-radius:var(--r2);max-width:92vw;display:none;z-index:9}
#toast.ok{background:#16254a;border-color:var(--accent)}
@media (min-width:481px){.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
@media (max-width:480px){
main:not(.xwide) table,main:not(.xwide) tbody,main:not(.xwide) tr,main:not(.xwide) td{display:block}
main:not(.xwide) thead{display:none}
main:not(.xwide) tr{border-top:1px solid var(--line);padding:.45rem 0}
main:not(.xwide) td{border:0;padding:.1rem 0}
main:not(.xwide) td.n,main:not(.xwide) td.a{display:inline-block;margin-right:.6rem;color:var(--muted);font-size:.8rem}
}

/* ---------- key hints: quiet, and only while navigating by keyboard ---------- */
u.k{text-decoration:none}
span.k{display:none;font-size:.7em;color:var(--muted);margin-left:.3em;font-weight:400}
body.kbd u.k{text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.18em;text-decoration-color:currentColor}
body.kbd span.k{display:inline}
@media (max-width:640px){body.kbd u.k{text-decoration:none}body.kbd span.k{display:none}}

/* ---------- Outcome editor: form + tooltips ---------- */
.form{display:grid;gap:12px .75rem;grid-template-columns:1fr 1fr}
.form.three{grid-template-columns:1fr 1fr 1fr}
.form .full{grid-column:1/-1}
.form label.field{margin:0}
.tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:1.25rem;height:1.25rem;border-radius:50%;border:1px solid #6a6aa0;color:var(--text2);font-size:.7rem;font-weight:700;cursor:help;flex:none;font-style:normal}
.tip:hover,.tip:focus,.tip.open{background:var(--accent);color:var(--ink);border-color:var(--accent);outline:none}
.tip .bubble{display:none;position:fixed;z-index:40;white-space:normal;text-transform:none;letter-spacing:0;width:min(20rem,80vw);background:var(--quiet);border:1px solid var(--accent);border-radius:var(--r2);padding:.5rem .65rem;color:var(--text);font-size:.85rem;font-weight:400;line-height:1.4;text-align:left;box-shadow:0 8px 24px #0009}
.tip.show .bubble{display:block}
.tip.info{margin-left:.35rem;vertical-align:2px;font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:.8rem;width:1.1rem;height:1.1rem}
main.xwide tr.orow:focus-visible .tip.info .bubble{display:block}
.uses{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;background:#101024;border:1px solid var(--line);border-radius:var(--r2);padding:.5rem .75rem}
.form:not(.three) .uses{grid-column:1/-1}
.uses .big{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}
.form-actions{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin-top:.25rem}
.form-actions .spacer{flex:1}
.hint{grid-column:1/-1;font-size:.85rem;color:var(--muted);margin:0}
.helpbar{grid-column:1/-1;min-height:2.6rem;display:flex;gap:.5rem;align-items:flex-start;background:var(--ink);border:1px dashed #3a3a6a;border-radius:var(--r2);padding:.4rem .6rem;font-size:.85rem;color:var(--text2)}
.helpbar b{color:var(--gold);white-space:nowrap}
.addbox{background:#0f0f22;border:1px solid #3a3a6a;border-radius:10px;padding:.75rem;margin-bottom:.5rem}
/* Giveaways: one button per Firebot act, the sentence of what it does right under it */
.gcontrols{display:grid;gap:.6rem;margin-top:.6rem}
.gbtn{padding-left:.6rem;border-left:3px solid transparent}
.gbtn.now{border-left-color:var(--accent)}
.gbtn button{min-width:12rem}
.gbtn p{margin:.2rem 0 0}
#giveaway-start input{flex:1 1 10rem}
@media (max-width:640px){.form,.form.three{grid-template-columns:1fr}.uses{grid-template-columns:1fr 1fr}}

/* ---------- Outcome editor: variant D, table, expand in place ---------- */
.toolbar{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.toolbar input{min-width:0;flex:1 1 10rem}
main.xwide section{padding:1rem 1.25rem}
main.xwide h2{display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap}
main.xwide h2 .count{color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400}
main.xwide .queuebar{display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap}
main.xwide .queuebar h2,main.xwide .queuebar p,main.xwide .queuebar .row{margin:0}
main.xwide table{font-size:1rem}
main.xwide th,main.xwide td{padding:.85rem .6rem;vertical-align:middle;white-space:nowrap}
main.xwide th{font-size:.75rem}
main.xwide th .tip{margin-left:.25rem}
main.xwide th.num,main.xwide td.num{text-align:right}
main.xwide td.num{font-variant-numeric:tabular-nums;padding-left:1.5rem;padding-right:1.5rem}
main.xwide td.name{white-space:normal;min-width:12rem;width:100%}
main.xwide td.name strong{font-size:1.05rem}
main.xwide td.name .sub{display:block;color:var(--muted);font-size:.85rem;font-weight:400;margin-top:.1rem}
main.xwide td.left strong{font-size:1.25rem}
main.xwide td.glyph{font-size:1.35rem;width:2.2rem}
main.xwide td.status::before{content:"";display:inline-block;width:.55rem;height:.55rem;border-radius:50%;background:currentColor;margin-right:.4rem;vertical-align:middle}
main.xwide td.act{text-align:right}
main.xwide td.act .actions{margin:0;justify-content:flex-end;flex-wrap:nowrap}
main.xwide:not(.modview) tr.orow td.act .actions{opacity:0;transition:opacity .12s}
main.xwide tr.orow:hover td.act .actions,main.xwide tr.orow:focus-visible td.act .actions,main.xwide tr.orow.open td.act .actions,main.xwide tr.orow:focus-within td.act .actions{opacity:1}
main.xwide tr.orow{cursor:pointer}
main.xwide.modview tr.orow{cursor:default}
main.xwide tr.orow:hover td{background:var(--quiet)}
main.xwide tr.orow:focus-visible,main.xwide tr.orow.open{outline:1px solid #26f0ffaa;outline-offset:-1px;box-shadow:0 0 14px 1px #26f0ff55;border-radius:6px}
main.xwide tr.orow:focus-visible td,main.xwide tr.orow.open td{background:#181836;border-top-color:transparent}
main.xwide tr.orow.open td{border-bottom:0}
main.xwide tr.orow.open+tr.expand td{border-top:0}
main.xwide tr.orow.retired td{color:var(--muted)}
main.xwide tr.orow.retired td.name strong{text-decoration:line-through}
main.xwide tr.expand td{background:#0f0f22;padding:.75rem;white-space:normal;border-top:0}
main.xwide tr.expand .form{padding:.25rem}
main.xwide tr.tier th{background:var(--panel);color:var(--gold);border-top:2px solid var(--line);padding-top:1.4rem;font-size:.85rem}
main.xwide tr.tier th span{color:var(--muted);text-transform:none;letter-spacing:0;font-weight:400;margin-left:.5rem}
main.xwide td.empty{white-space:normal}
.caret{display:inline-block;width:1rem;color:var(--muted);transition:transform .15s}
tr.open .caret{transform:rotate(90deg);color:var(--accent)}
.legend{position:fixed;inset:0;background:#000b;z-index:30;display:flex;align-items:center;justify-content:center;padding:1rem}
.legend>div{background:var(--panel);border:1px solid #3a3a6a;border-radius:var(--r);padding:1rem 1.25rem;max-width:36rem;width:100%;max-height:90vh;overflow:auto}
.legend h3{margin-top:0}
.legend table{font-size:.9rem}.legend td{white-space:normal;padding:.3rem .4rem}
.legend td:first-child{white-space:nowrap;width:9rem}
.keys{font-size:.8rem;color:var(--muted);margin:.5rem 0 0;display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
@media (max-width:640px){
main.xwide{padding:.75rem}
main.xwide section{padding:.75rem}
main.xwide table,main.xwide thead,main.xwide tbody,main.xwide tr,main.xwide td,main.xwide th{display:block}
main.xwide thead{display:none}
main.xwide tr.tier th{border:0;padding:.7rem 0 .2rem}
main.xwide tr.orow{display:grid;grid-template-columns:2.2rem 1fr auto;gap:.1rem .5rem;border-top:1px solid var(--line);padding:.5rem 0;align-items:center}
main.xwide tr.orow td{border:0;padding:.05rem 0;white-space:normal}
main.xwide tr.orow td.glyph{grid-row:span 3}
main.xwide tr.orow td.name{grid-column:2;min-width:0}
main.xwide tr.orow td.meta{grid-column:2;color:var(--muted);font-size:.85rem}
main.xwide tr.orow td.num.used{display:none}
main.xwide:not(.modview) tr.orow td.act .actions{opacity:1} /* phones: the buttons always show */
main.xwide td.name .sub{display:none}
main.xwide tr.orow td.num.left{grid-column:3;grid-row:1;text-align:right;font-size:1.1rem}
main.xwide tr.orow td.num.left small{display:block;font-size:.72rem;color:var(--muted);font-weight:400}
main.xwide tr.orow td.status{grid-column:3;grid-row:2;text-align:right;font-size:.85rem}
main.xwide tr.orow td.act{grid-column:2/4;grid-row:4;text-align:left;padding-top:.3rem}
main.xwide td.act .actions{justify-content:flex-start;flex-wrap:wrap}
main.xwide tr.orow:focus-visible td,main.xwide tr.orow.open td,main.xwide tr.orow:hover td{background:transparent;box-shadow:none}
main.xwide tr.orow.open{background:#181836;border-radius:10px 10px 0 0;padding:.5rem .4rem}
main.xwide tr.orow:focus-visible{outline:2px solid var(--gold);outline-offset:2px;border-radius:8px}
main.xwide tr.expand td{border-radius:10px;border:1px solid #3a3a6a}
.dsk{display:none!important}
}
@media (min-width:641px){.mob{display:none!important}}

/* ---------- Setup page: progress steps, numbered how-to lists, copy fields, switches ---------- */
.steps{list-style:none;margin:.5rem 0 0;padding:0;display:flex;gap:.4rem;flex-wrap:wrap}
.steps li{display:flex;align-items:center;gap:.4rem;padding:.3rem .7rem .3rem .4rem;border-radius:999px;background:var(--quiet);color:var(--muted);font-weight:600;font-size:.9rem}
.steps li.now{color:var(--text);outline:1px solid var(--accent)}
.steps li.done{color:var(--live)}
.steps .dot{display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;border-radius:50%;background:var(--panel);border:1px solid var(--line);font-size:.8rem}
.steps li.done .dot{background:var(--live);color:var(--ink);border-color:var(--live)}
.steps li.now .dot{background:var(--accent);color:var(--ink);border-color:var(--accent)}
.progress-line{margin:.6rem 0 0}
.howto{padding-left:1.4rem;margin:.5rem 0}
.howto li{margin:.45rem 0;line-height:1.45}
.copy{display:flex;gap:.4rem;margin:.4rem 0}
.copy input{flex:1 1 auto;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85rem}
label.switch{align-items:flex-start;gap:.6rem;margin:.6rem 0}
label.switch input[type=checkbox]{margin-top:.2rem;flex:none}
.setup section.optional{border-color:#1f1f44}
.setup h3{font-size:.95rem;margin:.9rem 0 .2rem}
.check-result{min-height:1.2em;margin:.3rem 0 0}
.check-result.no{color:var(--danger)}
.check-result.yes{color:var(--live)}
`;

export interface LayoutOptions {
  title: string;
  active: NavKey | null;
  principal: Principal;
  listener: AppListener;
  body: Raw;
  /** Extra classes on `<main>` — the Pool page's `xwide` (full width) and `modview` (a mod's view of the editor). */
  mainClass?: string;
}

/** The whole document. The Log out link only makes sense where a session exists — the funnel. */
export function layout({ title, active, principal, listener, body, mainClass }: LayoutOptions): string {
  const badge = principal.role === "streamer" ? (principal.login === null ? "Streamer" : `@${principal.login} · Streamer`) : `Mod · @${principal.login ?? "?"}`;
  return h`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · twitch-party-overlay</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header>
<nav>${NAV.filter(([key]) => (key !== "config" && key !== "debug") || principal.role === "streamer").map(([key, href, label]) => h`<a href="${href}"${key === active ? raw(' class="active"') : ""}>${label}</a>`)}</nav>
<div class="badge">${badge}${listener === "funnel" ? h`<a href="${LOGOUT_HREF}">Log out</a>` : ""}</div>
</header>
<main${mainClass === undefined ? "" : h` class="${mainClass}"`}>
${body}
</main>
<div id="toast" role="alert"></div>
<script src="${CLIENT_JS_PATH}"></script>
</body>
</html>
`.html;
}
