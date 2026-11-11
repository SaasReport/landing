/**
 * What a customer sees about an upload: a reason code and one plain sentence, nothing else (no signature names, scanner output
 * or stack traces). This is the kit's English copy; a project supplies its own locale pack of the same shape (validated as a
 * copy pack) and passes it to publicOutcome. States: accepted, under_review, blocked, could_not_check.
 */
export const UPLOAD_COPY = {
  en: {
    status: {
      accepted: "Your file was received.",
      under_review: "Your file was received and is being reviewed before it is made available.",
      blocked: "We could not accept this file.",
      could_not_check: "We could not check this file. Try another file or contact us and quote the reference.",
    },
    reasons: {
      type_not_allowed: "This type of file is not accepted here.",
      type_mismatch: "The file is not the type its name says it is.",
      too_large: "The file is too large.",
      active_content_found: "The file contains active content that we do not accept.",
      archive_not_allowed: "Archives are not accepted here.",
      archive_bomb: "The file expands to an unreasonable size.",
      polyglot_suspect: "The file is built in an unusual way and was not accepted.",
      malware_detected: "The file was not accepted.",
      could_not_check: "We could not check this file.",
    },
  },
};
