import { test } from "node:test";
import assert from "node:assert/strict";
import { speakable, unspeakable, numberWords, ordinalWords, numberWordsEn, numbersIn, mergeTurns, estimateMs, termsFor } from "../src/index.js";

test("Persian numbers and ordinals", () => {
  assert.equal(numberWords(0), "صفر");
  assert.equal(numberWords(1404), "هزار و چهارصد و چهار");
  assert.equal(numberWords(12500000), "دوازده میلیون و پانصد هزار");
  assert.equal(numberWords(2026), "دو هزار و بیست و شش");
  assert.deepEqual([1, 3, 13, 23, 30].map(ordinalWords), ["یکم", "سوم", "سیزدهم", "بیست و سوم", "سی‌ام"]);
});

test("speakable (fa) turns dates, codes and Latin terms into Persian speech", () => {
  assert.equal(speakable("پنجشنبه ۲۸ اسفند ۱۴۰۴ با T+1"), "پنجشنبه بیست و هشتم اسفند هزار و چهارصد و چهار با تی پلاس یک");
  assert.equal(speakable("تاریخ 1405/01/05", "fa"), "تاریخ پنجم فروردین هزار و چهارصد و پنج");
  assert.equal(speakable("**API** و MCP در `demo-cal` https://x.y/z", { locale: "fa-IR" }), "ای‌پی‌آی و اِم‌سی‌پی در");
  assert.equal(speakable("نرخ ۲۳٪ و ۱٬۲۰۰"), "نرخ بیست و سه درصد و هزار و دویست");
  assert.doesNotMatch(speakable("hello world T+n SDK"), /[A-Za-z0-9]/);
  assert.deepEqual(numbersIn("۲۸ اسفند 1404 و ۱٬۲۰۰"), [28, 1404, 1200]);
});

test("project terms come from options, not the core list", () => {
  assert.equal(termsFor("fa").some(([k]) => k === "ACME"), false);
  assert.equal(speakable("سلام از ACME", { terms: [["ACME", "اِکمی"]] }), "سلام از اِکمی");
  assert.equal(speakable("API", { terms: { API: "اِی پی آی" } }), "اِی پی آی");
  assert.equal(speakable("API", { defaults: false }), "اِی‌پی‌آی"); // falls back to spelling letters
  assert.equal(unspeakable("همه چیز خوب است"), "");
});

test("speakable (en): numbers in words, markdown stripped", () => {
  assert.equal(numberWordsEn(2026), "two thousand twenty-six");
  assert.equal(numberWordsEn(115), "one hundred fifteen");
  assert.equal(speakable("**Rates** rose 23% in 2026, see https://x.y", "en"), "Rates rose twenty-three percent in two thousand twenty-six, see");
  assert.equal(speakable("Settles T+1", { locale: "en-US" }), "Settles T plus one");
  assert.equal(unspeakable("API v2", "en"), "");
  assert.equal(speakable("pi is 3.14", "en"), "pi is three point one four");
});

test("mergeTurns and estimateMs", () => {
  const m = mergeTurns([{ speaker: "a", text: "x" }, { speaker: "a", text: "y" }, { speaker: "b", text: "z" }]);
  assert.deepEqual(m, [{ speaker: "a", text: "x y" }, { speaker: "b", text: "z" }]);
  assert.equal(estimateMs([{ text: "a".repeat(110) }]), 10000);
  assert.equal(estimateMs([["host", "a".repeat(100)]], 10), 10000);
  assert.equal(estimateMs(["a".repeat(20)], 20), 1000);
});

test("brand marks are dropped before synthesis in every locale", () => {
  assert.equal(speakable("Acme™ podcast", { locale: "en" }), "Acme podcast");
  assert.ok(!speakable("یک دقیقه با ایران اوپن فاینانس™").includes("™"));
  assert.ok(!speakable("Acme® ٥٪", { locale: "ar" }).includes("®"));
});
