/**
 * Input guardrails for the catalogue assistant, adapted from the katiba.ai prompt-engineering
 * pre-generation stage. These screen the LATEST user turn before any model call, so a prompt-
 * injection or jailbreak attempt is refused rather than reaching the LLM. Grounding discipline and
 * domain-lock live in the system prompt (see assistant.ts); this is the fast, deterministic gate.
 */

// Prompt-injection + jailbreak signatures. Kept deliberately narrow so ordinary catalogue questions
// (which never contain these) are unaffected.
const MISUSE_PATTERNS: RegExp[] = [
  /ignore\s+(?:the\s+|all\s+|your\s+|previous\s+)*(?:instructions|prompts?|rules|context|guardrails)/i,
  /disregard\s+(?:the\s+|all\s+|your\s+|previous\s+)*(?:instructions|prompts?|rules)/i,
  /forget\s+(?:the\s+|all\s+|your\s+|previous\s+)*(?:instructions|prompts?|rules)/i,
  /override\s+(?:the\s+)?(?:system|rules|instructions|guardrails)/i,
  /(?:reveal|show|print|repeat|output|expose|give\s+me)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|rules)/i,
  /you\s+are\s+now\s+\S/i,
  /new\s+instructions?\s*:/i,
  /system\s*:\s*you\b/i,
  /\bact\s+as\s+(?!(?:a\s+)?catalogue)/i,
  /pretend\s+(?:you|to\s+be|that)/i,
  /roleplay\s+as/i,
  /simulate\s+(?:being|a\b|that)/i,
  /bypass\s+(?:the|your)\s+(?:rules|constraints|limitations|guardrails|filters)/i,
  /\bjailbreak/i,
  /\bDAN\b/,
  /developer\s+mode/i,
];

/** True when the text looks like a prompt-injection or jailbreak attempt. */
export function looksLikeMisuse(text: string): boolean {
  return MISUSE_PATTERNS.some((pattern) => pattern.test(text));
}

/** The polite, on-domain refusal returned when a turn is screened out. */
export const MISUSE_REFUSAL =
  "I can only help with using Catalog Sentinel and with questions about your own catalogue and audits, " +
  "and I can't change those instructions. Ask me about your releases, store coverage, missing songs, " +
  'or lyrics and I’ll help.';
