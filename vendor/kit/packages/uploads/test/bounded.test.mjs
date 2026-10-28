// The bounded reader: the cap is enforced while the body streams, never after buffering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBounded, readBoundedJson, readBoundedText, declaredLength, bodyErrorResponse, BodyError } from "../src/bounded.js";
import { validateError } from "../src/schemas.js";
import { enc, req } from "./fixtures.mjs";

const fakeSource = (chunks, headers = {}) => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream({ pull(c) { if (pulled < chunks.length) c.enqueue(chunks[pulled++]); else c.close(); }, cancel() { cancelled = true; } });
  return { source: { body, headers: new Headers(headers) }, stats: () => ({ pulled, cancelled }) };
};
const code = async (p) => { try { await p; return "no error"; } catch (e) { assert.ok(e instanceof BodyError, String(e)); return e.code; } };

test("reads a body within the cap and returns its bytes", async () => {
  const { source } = fakeSource([enc("hello "), enc("world")], { "content-length": "11" });
  const r = await readBounded(source, { maxBytes: 11 });
  assert.equal(new TextDecoder().decode(r.bytes), "hello world");
  assert.equal(r.size, 11);
});

test("a declared length over the cap is refused before one byte is read, and the stream is cancelled", async () => {
  const { source, stats } = fakeSource([new Uint8Array(1000)], { "content-length": "1000" });
  assert.equal(await code(readBounded(source, { maxBytes: 999 })), "too_large");
  assert.equal(stats().pulled, 0);
  assert.equal(stats().cancelled, true);
});

test("the cap is enforced while streaming: an endless body is cut after the cap, not after buffering", async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
  const source = { body, headers: new Headers({ "content-length": "1099511627776" }) };   // declares 1 TiB: refused outright
  assert.equal(await code(readBounded(source, { maxBytes: 4096 })), "too_large");
  assert.ok(pulled <= 2, `pulled ${pulled} chunks of an endless body`);
  // no usable Content-Length on an endless body: "optional" mode still stops at the cap
  let n = 0;
  const endless = { body: new ReadableStream({ pull(c) { n++; c.enqueue(new Uint8Array(1024)); } }), headers: new Headers() };
  assert.equal(await code(readBounded(endless, { maxBytes: 4096, contentLength: "optional" })), "too_large");
  assert.ok(n <= 6, `read ${n} chunks (cap is 4)`);
});

test("a missing Content-Length is refused (411 length_required) unless the caller opts out", async () => {
  const mk = () => fakeSource([enc("abc")]).source;
  assert.equal(await code(readBounded(mk(), { maxBytes: 100 })), "length_required");
  const r = await readBounded(mk(), { maxBytes: 100, contentLength: "optional" });
  assert.equal(r.size, 3);
});

test("a Content-Length that is not plain digits is refused", async () => {
  for (const bad of ["10, 20", "-1", "0x10", "1e3", "+5", " ", "", "12abc", "99999999999999999999", "1.5"]) {
    const { source } = fakeSource([enc("abc")], { "content-length": bad });
    assert.equal(await code(readBounded(source, { maxBytes: 100 })), "bad_content_length", JSON.stringify(bad));
  }
  assert.equal(declaredLength(new Headers()), null);
});

test("a lying Content-Length is refused: more bytes than declared, fewer than declared, or a body when none is declared", async () => {
  assert.equal(await code(readBounded(fakeSource([enc("abcdef")], { "content-length": "3" }).source, { maxBytes: 100 })), "length_mismatch");
  assert.equal(await code(readBounded(fakeSource([enc("ab")], { "content-length": "3" }).source, { maxBytes: 100 })), "length_mismatch");
  assert.equal(await code(readBounded({ body: null, headers: new Headers({ "content-length": "3" }) }, { maxBytes: 100 })), "length_mismatch");
  const { source, stats } = fakeSource([enc("abc"), enc("def"), enc("ghi")], { "content-length": "3" });
  assert.equal(await code(readBounded(source, { maxBytes: 100 })), "length_mismatch");
  assert.equal(stats().cancelled, true);
});

test("exactly the cap passes, one byte more fails", async () => {
  assert.equal((await readBounded(fakeSource([new Uint8Array(10)], { "content-length": "10" }).source, { maxBytes: 10 })).size, 10);
  assert.equal(await code(readBounded(fakeSource([new Uint8Array(11)], { "content-length": "11" }).source, { maxBytes: 10 })), "too_large");
});

test("an empty body is fine", async () => {
  const r = await readBounded({ body: null, headers: new Headers() }, { maxBytes: 10 });
  assert.equal(r.size, 0);
  const r2 = await readBounded(req(null, { "content-length": "0" }, { method: "POST" }), { maxBytes: 10 });
  assert.equal(r2.size, 0);
});

test("a Request works as a source", async () => {
  const r = await readBoundedJson(req('{"a":1}', { "content-length": "7" }), { maxBytes: 100 });
  assert.deepEqual(r.value, { a: 1 });
});

test("text must be valid UTF-8 and JSON must parse", async () => {
  const bad = fakeSource([Uint8Array.of(0xff, 0xfe, 0xfd)], { "content-length": "3" }).source;
  assert.equal(await code(readBoundedText(bad, { maxBytes: 10 })), "read_failed");
  assert.equal(await code(readBoundedJson(fakeSource([enc("{nope")], { "content-length": "5" }).source, { maxBytes: 10 })), "invalid_json");
});

test("a failing stream is a read_failed, not a crash", async () => {
  const body = new ReadableStream({ pull() { throw new Error("socket reset"); } });
  assert.equal(await code(readBounded({ body, headers: new Headers({ "content-length": "5" }) }, { maxBytes: 10 })), "read_failed");
});

test("every refusal answers with a kit.upload-error.v1 body and the right status", async () => {
  for (const [c, status] of [["too_large", 413], ["length_required", 411], ["bad_content_length", 400], ["length_mismatch", 400], ["read_failed", 400], ["invalid_json", 400]]) {
    const res = bodyErrorResponse(new BodyError(c));
    assert.equal(res.status, status, c);
    assert.deepEqual(validateError(await res.json()), [], c);
  }
  assert.throws(() => bodyErrorResponse(new Error("other")));
});
