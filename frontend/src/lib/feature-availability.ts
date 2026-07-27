/**
 * Features that depend on the retired Lambda/audio backend stay disabled until
 * their replacement services are deployed. Keeping this explicit prevents the
 * UI from selling or deep-linking into endpoints that are intentionally down.
 */
export const ASK_PULSE_AVAILABLE = false;
export const KEYWORD_PUSH_AVAILABLE = false;
