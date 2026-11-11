/**
 * The one place this package touches @saasreport/speech (documented API):
 *   speakable(text, { locale }) → text a TTS engine can read aloud
 *   mergeTurns(lines)           → same speaker twice in a row becomes one turn
 *   numbersIn(text)             → integers written with digits (for the factual guard)
 *   estimateMs(lines, cps)      → rough spoken length
 */
import * as speech from "@saasreport/speech";

/** config.tts.terms adds project-specific spoken forms of Latin terms. */
export const speak = (text, locale, terms) => speech.speakable(text, terms ? { locale, terms } : { locale });
export const mergeTurns = (lines) => speech.mergeTurns(lines);
export const numbersIn = (text) => speech.numbersIn(text);
export const estimateMs = (lines, cps) => speech.estimateMs(lines, cps);
