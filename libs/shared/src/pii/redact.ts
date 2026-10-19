/**
 * Irreversible PII redaction for data that is persisted or displayed for
 * observability purposes (e.g. per-node execution traces).
 *
 * Design rules:
 * - A match is replaced by a short placeholder (`[CPF]`, `[EMAIL]`, ...). The
 *   original value is discarded: there is no vault and no mapping back.
 * - Only structured identifiers are detected. Names, addresses, free text and
 *   health information are NOT detected (see SAUDE_RULES, reserved for later).
 * - Where a cheap validation exists (check digits, Luhn, octet range, DDD) it is
 *   applied to reduce false positives.
 * - Redaction applies to the stored/displayed copy only; callers must keep
 *   passing the original data to the agent.
 */

export type PiiCategory = 'identificadores' | 'financeiro' | 'credenciais' | 'saude';

export interface PiiRule {
  id: string;
  category: PiiCategory;
  placeholder: string;
  /** Must carry the global flag. */
  pattern: RegExp;
  /** Optional extra check on the matched text; return false to keep the text. */
  validate?: (match: string) => boolean;
}

export interface CustomPiiPattern {
  pattern: RegExp;
  /** Defaults to `[REDACTED]`. */
  placeholder?: string;
}

export interface RedactOptions {
  /** Extra patterns (e.g. per-tenant). Always replaced by their placeholder. */
  extraPatterns?: CustomPiiPattern[];
}

export const REDACTED_PLACEHOLDER = '[REDACTED]';
export const TRUNCATED_PLACEHOLDER = '[TRUNCADO]';

const MAX_DEPTH = 32;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function allSameDigit(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

export function isValidCpf(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || allSameDigit(digits)) return false;
  const d = digits.split('').map(Number);
  const check = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += (d[i] as number) * (len + 1 - i);
    return ((sum * 10) % 11) % 10;
  };
  return check(9) === d[9] && check(10) === d[10];
}

export function isValidCnpj(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || allSameDigit(digits)) return false;
  const d = digits.split('').map(Number);
  const check = (len: number): number => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += (d[i] as number) * (weights[i] as number);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === d[12] && check(13) === d[13];
}

export function isValidCardNumber(value: string): boolean {
  const digits = onlyDigits(value);
  if (digits.length < 13 || digits.length > 19) return false;
  // Major card networks start with 2-6; this also avoids epoch-millisecond strings.
  if (!/^[2-6]/.test(digits) || allSameDigit(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

const BR_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
  49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function isValidBrPhone(value: string): boolean {
  let digits = onlyDigits(value);
  const hasSeparators = /\D/.test(value);
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length !== 10 && digits.length !== 11) return false;
  if (!BR_DDD.has(Number(digits.slice(0, 2)))) return false;
  if (digits.length === 11) return digits[2] === '9';
  // 10 digits (landline): require visible formatting so bare digit runs
  // (e.g. epoch seconds) are not mistaken for phone numbers.
  return hasSeparators && /^[2-5]/.test(digits.slice(2));
}

// ---------------------------------------------------------------------------
// Rules, organised by category. Order matters: more specific / longer digit
// patterns come before looser ones (CNPJ, CPF and card before phone).
// ---------------------------------------------------------------------------

export const CREDENCIAIS_RULES: PiiRule[] = [
  {
    id: 'token',
    category: 'credenciais',
    placeholder: '[TOKEN]',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
  },
  {
    id: 'bearer-token',
    category: 'credenciais',
    placeholder: '[TOKEN]',
    pattern: /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  },
];

export const IDENTIFICADORES_RULES: PiiRule[] = [
  {
    id: 'email',
    category: 'identificadores',
    placeholder: '[EMAIL]',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    id: 'cnpj',
    category: 'identificadores',
    placeholder: '[CNPJ]',
    pattern: /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/g,
    validate: isValidCnpj,
  },
  {
    id: 'cpf',
    category: 'identificadores',
    placeholder: '[CPF]',
    pattern: /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/g,
    validate: isValidCpf,
  },
];

export const FINANCEIRO_RULES: PiiRule[] = [
  {
    id: 'cartao',
    category: 'financeiro',
    placeholder: '[CARTAO]',
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    validate: isValidCardNumber,
  },
];

export const REDE_E_CONTATO_RULES: PiiRule[] = [
  {
    id: 'ipv4',
    category: 'identificadores',
    placeholder: '[IP]',
    pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g,
    validate: isValidIpv4,
  },
  {
    id: 'telefone-br',
    category: 'identificadores',
    placeholder: '[TELEFONE]',
    pattern: /(?<!\d)(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\d{2})[\s.-]?(?:9[\s.-]?)?\d{4}[\s.-]?\d{4}(?!\d)/g,
    validate: isValidBrPhone,
  },
];

/**
 * Reserved for health-related categories (LGPD sensitive data). Intentionally
 * empty: no detection is performed yet. Add rules here without touching the
 * engine; they are applied last.
 */
export const SAUDE_RULES: PiiRule[] = [];

export const DEFAULT_PII_RULES: readonly PiiRule[] = [
  ...CREDENCIAIS_RULES,
  ...IDENTIFICADORES_RULES,
  ...FINANCEIRO_RULES,
  ...REDE_E_CONTATO_RULES,
  ...SAUDE_RULES,
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function toGlobal(pattern: RegExp): RegExp {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

function applyRule(text: string, rule: PiiRule): string {
  const pattern = toGlobal(rule.pattern);
  pattern.lastIndex = 0;
  return text.replace(pattern, (match) => (rule.validate && !rule.validate(match) ? match : rule.placeholder));
}

/** Replaces PII found in a string by placeholders. Original values are discarded. */
export function redactText(input: string, options: RedactOptions = {}): string {
  if (!input) return input;
  let out = input;
  for (const rule of DEFAULT_PII_RULES) out = applyRule(out, rule);
  for (const custom of options.extraPatterns ?? []) {
    out = out.replace(toGlobal(custom.pattern), custom.placeholder ?? REDACTED_PLACEHOLDER);
  }
  return out;
}

/**
 * Returns a copy of `value` with every string redacted. Arrays and plain
 * objects are walked recursively; other values (numbers, booleans, Dates, ...)
 * are returned as-is. Circular references and excessive depth are replaced
 * by a marker instead of throwing.
 */
export function redactDeep<T>(value: T, options: RedactOptions = {}): T {
  const ancestors = new WeakSet<object>();

  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactText(node, options);
    if (node === null || typeof node !== 'object') return node;
    if (depth >= MAX_DEPTH || ancestors.has(node)) return TRUNCATED_PLACEHOLDER;

    if (Array.isArray(node)) {
      ancestors.add(node);
      const result = node.map((item) => walk(item, depth + 1));
      ancestors.delete(node);
      return result;
    }

    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;

    ancestors.add(node);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) result[key] = walk(item, depth + 1);
    ancestors.delete(node);
    return result;
  };

  return walk(value, 0) as T;
}
