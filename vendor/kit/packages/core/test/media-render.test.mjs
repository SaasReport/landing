import test from "node:test";
import assert from "node:assert/strict";
import { planMediaBundle } from "../src/media.js";
import { renderMediaDerivatives } from "../src/media-render.js";
const H="f".repeat(64);
const bundle=planMediaBundle({project:"demo",tenant:"site",content_id:"legal-term",edition:"v1",
 title:'مجوز <script>alert(1)</script>',locale:"fa-IR",
 source:{ref:"verified/legal",sha256:H,verified_at:"2026-10-25T10:00:00Z",
 citations:[{ref:"primary",url:"https://example.org/primary",verified:true}]}});
const THEME = { primary: "#" + "123456", surface: "#" + "fefefe", subtle: "#" + "515151" };
const facts=[{heading:"تعریف",text:"استفاده از نرم‌افزار طبق مجوز آن تعیین می‌شود.",citations:["primary"]},
 {heading:"منبع",text:"منبع قابل بررسی است.",citations:["primary"]}];
test("portable renders are deterministic, content-addressed, evidence-linked and NOT a video or published MP3",()=>{
 const a=renderMediaDerivatives(bundle,facts,{theme:THEME});
 assert.deepEqual(a,renderMediaDerivatives(bundle,facts,{theme:THEME}));
 assert.equal(a.published,false);
 assert.match(a.blog.body,/dir="rtl"/);
 assert.doesNotMatch(a.blog.body,/<script>alert/);
 assert.match(a.blog.body,/&lt;script&gt;/);
 assert.match(a.infographic.body,/<svg /);
 assert.match(a.infographic.body,/<desc>Verified source:/);
 assert.equal(a.infographic.sha256.length,64);
 assert.match(a.clip.captions,/^WEBVTT/);
 assert.equal(a.clip.storyboards.length,2);
 assert.equal(a.clip.state,"storyboard-needs-video-provider");
 assert.equal(a.podcast.state,"needs-reviewed-script-and-tts");
});
test("refuse invented facts or unreviewed citations; no XSS injection in SVG or blog",()=>{
 assert.throws(()=>renderMediaDerivatives(bundle,[{heading:"Fake",text:"no evidence",citations:["invented"]}],{theme:THEME}),/citation/);
 assert.throws(()=>renderMediaDerivatives(bundle,[],{theme:THEME}),/1-5/);
 const r=renderMediaDerivatives(bundle,[{heading:'<img onerror="x">',text:"<script>bad()</script>",citations:["primary"]}],{theme:THEME});
 assert.doesNotMatch(r.infographic.body,/<img /);
 assert.doesNotMatch(r.blog.body,/<script>bad/);
 assert.match(r.infographic.body,/&lt;img/);
 assert.throws(()=>renderMediaDerivatives(bundle,facts,{theme:{...THEME,primary:"red"}}),/resolved canonical theme tokens/);
 assert.ok(r.infographic.body.includes('fill="' + THEME.surface + '"'));
 assert.ok(r.infographic.body.includes('fill="' + THEME.primary + '"'));
});
